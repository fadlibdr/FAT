import { Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { PermType } from "@fat/shared";
import { PermissionService } from "../permissions/permission.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

type Filters = Record<string, string | undefined>;

interface ReportFilter {
  fieldname: string;
  label: string;
  fieldtype: string;
}

interface QueryReport {
  /** DocType whose Report permission gates access. */
  permDoctype: string;
  columns: { key: string; label: string }[];
  /** Declared filters (for the UI); values arrive as query params. */
  filters?: ReportFilter[];
  /** Static SQL (no params) ... */
  sql?: string;
  /** ... or a builder that turns filters into parameterized SQL. */
  build?: (f: Filters) => { text: string; params: unknown[] };
}

const today = () => new Date().toISOString().slice(0, 10);

/** Named server reports built from ledger tables. */
const REPORTS: Record<string, QueryReport> = {
  "trial-balance": {
    permDoctype: "GL Entry",
    columns: [
      { key: "account", label: "Account" },
      { key: "debit", label: "Debit" },
      { key: "credit", label: "Credit" },
      { key: "balance", label: "Balance" },
    ],
    sql: `SELECT "account",
                 coalesce(sum("debit"),0)::float8 AS "debit",
                 coalesce(sum("credit"),0)::float8 AS "credit",
                 (coalesce(sum("debit"),0) - coalesce(sum("credit"),0))::float8 AS "balance"
          FROM "tabGL Entry" GROUP BY "account" ORDER BY "account"`,
  },
  "stock-balance": {
    permDoctype: "Bin",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "actual_qty", label: "Qty" },
      { key: "valuation_rate", label: "Valuation Rate" },
      { key: "stock_value", label: "Stock Value" },
    ],
    sql: `SELECT "item_code", "warehouse",
                 sum("actual_qty")::float8 AS "actual_qty",
                 (CASE WHEN sum("actual_qty") <> 0
                       THEN sum("stock_value") / sum("actual_qty") ELSE 0 END)::float8 AS "valuation_rate",
                 sum("stock_value")::float8 AS "stock_value"
          FROM "tabBin"
          GROUP BY "item_code", "warehouse"
          HAVING sum("actual_qty") <> 0
          ORDER BY "item_code", "warehouse"`,
  },
  "profit-and-loss": {
    permDoctype: "GL Entry",
    columns: [
      { key: "account", label: "Account" },
      { key: "account_type", label: "Type" },
      { key: "debit", label: "Debit" },
      { key: "credit", label: "Credit" },
      { key: "amount", label: "Amount" },
    ],
    sql: `SELECT gl."account", a."account_type",
                 sum(gl."debit")::float8 AS "debit",
                 sum(gl."credit")::float8 AS "credit",
                 (sum(gl."credit") - sum(gl."debit"))::float8 AS "amount"
          FROM "tabGL Entry" gl JOIN "tabAccount" a ON a."name" = gl."account"
          WHERE a."account_type" IN ('Income','Expense')
          GROUP BY gl."account", a."account_type"
          ORDER BY a."account_type", gl."account"`,
  },
  "balance-sheet": {
    permDoctype: "GL Entry",
    columns: [
      { key: "account", label: "Account" },
      { key: "account_type", label: "Type" },
      { key: "balance", label: "Balance" },
    ],
    sql: `SELECT gl."account", a."account_type",
                 (CASE WHEN a."account_type" = 'Asset'
                       THEN sum(gl."debit") - sum(gl."credit")
                       ELSE sum(gl."credit") - sum(gl."debit") END)::float8 AS "balance"
          FROM "tabGL Entry" gl JOIN "tabAccount" a ON a."name" = gl."account"
          WHERE a."account_type" IN ('Asset','Liability','Equity')
          GROUP BY gl."account", a."account_type"
          ORDER BY a."account_type", gl."account"`,
  },
  "budget-variance": {
    permDoctype: "GL Entry",
    columns: [
      { key: "cost_center", label: "Cost Center" },
      { key: "account", label: "Account" },
      { key: "budget_amount", label: "Budget" },
      { key: "actual", label: "Actual" },
      { key: "variance", label: "Variance" },
    ],
    sql: `SELECT b."cost_center", b."account",
                 b."budget_amount"::float8 AS "budget_amount",
                 coalesce(act."actual", 0)::float8 AS "actual",
                 (b."budget_amount" - coalesce(act."actual", 0))::float8 AS "variance"
          FROM "tabBudget" b
          LEFT JOIN (
            SELECT "account", "cost_center", sum("debit") - sum("credit") AS "actual"
            FROM "tabGL Entry" GROUP BY "account", "cost_center"
          ) act ON act."account" = b."account" AND act."cost_center" = b."cost_center"
          ORDER BY b."cost_center", b."account"`,
  },
  "batch-stock-balance": {
    permDoctype: "Stock Ledger Entry",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "batch_no", label: "Batch" },
      { key: "qty", label: "Qty" },
    ],
    sql: `SELECT "item_code", "warehouse", "batch_no",
                 sum("actual_qty")::float8 AS "qty"
          FROM "tabStock Ledger Entry"
          WHERE "batch_no" IS NOT NULL AND "batch_no" <> ''
          GROUP BY "item_code", "warehouse", "batch_no"
          HAVING sum("actual_qty") <> 0
          ORDER BY "item_code", "warehouse", "batch_no"`,
  },
  "accounts-receivable": {
    permDoctype: "Sales Invoice",
    columns: [
      { key: "party", label: "Customer" },
      { key: "voucher", label: "Invoice" },
      { key: "posting_date", label: "Posting Date" },
      { key: "due_date", label: "Due Date" },
      { key: "age", label: "Age (days)" },
      { key: "outstanding", label: "Outstanding" },
      { key: "range_0_30", label: "0-30" },
      { key: "range_31_60", label: "31-60" },
      { key: "range_61_90", label: "61-90" },
      { key: "range_90_plus", label: "90+" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    build: (f) => agingSql("Sales Invoice", "customer", f.as_of || today()),
  },
  "accounts-payable": {
    permDoctype: "Purchase Invoice",
    columns: [
      { key: "party", label: "Supplier" },
      { key: "voucher", label: "Invoice" },
      { key: "posting_date", label: "Posting Date" },
      { key: "due_date", label: "Due Date" },
      { key: "age", label: "Age (days)" },
      { key: "outstanding", label: "Outstanding" },
      { key: "range_0_30", label: "0-30" },
      { key: "range_31_60", label: "31-60" },
      { key: "range_61_90", label: "61-90" },
      { key: "range_90_plus", label: "90+" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    build: (f) => agingSql("Purchase Invoice", "supplier", f.as_of || today()),
  },
  "customer-statement": {
    permDoctype: "GL Entry",
    columns: [
      { key: "posting_date", label: "Date" },
      { key: "voucher_type", label: "Voucher Type" },
      { key: "voucher_no", label: "Voucher No" },
      { key: "debit", label: "Debit" },
      { key: "credit", label: "Credit" },
      { key: "balance", label: "Balance" },
    ],
    filters: [
      { fieldname: "customer", label: "Customer", fieldtype: "Link" },
      { fieldname: "account", label: "Receivable Account", fieldtype: "Link" },
      { fieldname: "from_date", label: "From Date", fieldtype: "Date" },
      { fieldname: "to_date", label: "To Date", fieldtype: "Date" },
    ],
    // A statement of account: every receivable movement for one customer
    // (invoices Dr, payments Cr, dunning interest Dr) with a running balance.
    build: (f) => {
      const params: unknown[] = [f.account || "Debtors", f.customer || ""];
      const where = [`"account" = $1`, `"against" = $2`];
      if (f.from_date) { params.push(f.from_date); where.push(`"posting_date" >= $${params.length}`); }
      if (f.to_date) { params.push(f.to_date); where.push(`"posting_date" <= $${params.length}`); }
      return {
        text: `SELECT "posting_date", "voucher_type", "voucher_no",
                      "debit"::float8 AS "debit", "credit"::float8 AS "credit",
                      (sum("debit" - "credit") OVER (ORDER BY "posting_date", "creation"
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::float8 AS "balance"
               FROM "tabGL Entry"
               WHERE ${where.join(" AND ")}
               ORDER BY "posting_date", "creation"`,
        params,
      };
    },
  },
  "general-ledger": {
    permDoctype: "GL Entry",
    columns: [
      { key: "posting_date", label: "Date" },
      { key: "account", label: "Account" },
      { key: "voucher_type", label: "Voucher Type" },
      { key: "voucher_no", label: "Voucher No" },
      { key: "against", label: "Against" },
      { key: "debit", label: "Debit" },
      { key: "credit", label: "Credit" },
      { key: "balance", label: "Balance" },
    ],
    filters: [
      { fieldname: "account", label: "Account", fieldtype: "Link" },
      { fieldname: "party", label: "Party", fieldtype: "Data" },
      { fieldname: "from_date", label: "From Date", fieldtype: "Date" },
      { fieldname: "to_date", label: "To Date", fieldtype: "Date" },
    ],
    build: (f) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (f.account) { params.push(f.account); where.push(`"account" = $${params.length}`); }
      if (f.party) { params.push(f.party); where.push(`"against" = $${params.length}`); }
      if (f.from_date) { params.push(f.from_date); where.push(`"posting_date" >= $${params.length}`); }
      if (f.to_date) { params.push(f.to_date); where.push(`"posting_date" <= $${params.length}`); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return {
        text: `SELECT "posting_date", "account", "voucher_type", "voucher_no", "against",
                      "debit"::float8 AS "debit", "credit"::float8 AS "credit",
                      (sum("debit" - "credit") OVER (ORDER BY "posting_date", "creation"
                        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::float8 AS "balance"
               FROM "tabGL Entry" ${clause}
               ORDER BY "posting_date", "creation"`,
        params,
      };
    },
  },
  "sales-register": {
    permDoctype: "Sales Invoice",
    columns: [
      { key: "invoice", label: "Invoice" },
      { key: "party", label: "Customer" },
      { key: "posting_date", label: "Posting Date" },
      { key: "net_total", label: "Net Total" },
      { key: "tax", label: "Tax" },
      { key: "grand_total", label: "Grand Total" },
      { key: "outstanding", label: "Outstanding" },
      { key: "status", label: "Status" },
    ],
    filters: [
      { fieldname: "from_date", label: "From Date", fieldtype: "Date" },
      { fieldname: "to_date", label: "To Date", fieldtype: "Date" },
    ],
    build: (f) => registerSql("Sales Invoice", "customer", f),
  },
  "purchase-register": {
    permDoctype: "Purchase Invoice",
    columns: [
      { key: "invoice", label: "Invoice" },
      { key: "party", label: "Supplier" },
      { key: "posting_date", label: "Posting Date" },
      { key: "net_total", label: "Net Total" },
      { key: "tax", label: "Tax" },
      { key: "grand_total", label: "Grand Total" },
      { key: "outstanding", label: "Outstanding" },
      { key: "status", label: "Status" },
    ],
    filters: [
      { fieldname: "from_date", label: "From Date", fieldtype: "Date" },
      { fieldname: "to_date", label: "To Date", fieldtype: "Date" },
    ],
    build: (f) => registerSql("Purchase Invoice", "supplier", f),
  },
};

/**
 * Aging of open invoices for a party, bucketed by days overdue relative to
 * `asOf`. Positive outstanding only (a credit/debit note nets separately).
 * Identifiers are literals; only the as-of date is parameterized.
 */
function agingSql(doctype: string, partyField: string, asOf: string): { text: string; params: unknown[] } {
  const table = `tab${doctype}`;
  return {
    text: `SELECT "party", "voucher", "posting_date", "due_date", "age",
                  "outstanding"::float8 AS "outstanding",
                  (CASE WHEN "age" <= 30 THEN "outstanding" ELSE 0 END)::float8 AS "range_0_30",
                  (CASE WHEN "age" > 30 AND "age" <= 60 THEN "outstanding" ELSE 0 END)::float8 AS "range_31_60",
                  (CASE WHEN "age" > 60 AND "age" <= 90 THEN "outstanding" ELSE 0 END)::float8 AS "range_61_90",
                  (CASE WHEN "age" > 90 THEN "outstanding" ELSE 0 END)::float8 AS "range_90_plus"
           FROM (
             SELECT "${partyField}" AS "party", "name" AS "voucher", "posting_date", "due_date",
                    "outstanding_amount" AS "outstanding",
                    ($1::date - coalesce("due_date", "posting_date"))::int AS "age"
             FROM "${table}"
             WHERE "docstatus" = 1 AND "outstanding_amount" > 0.0001
           ) t ORDER BY "party", "posting_date"`,
    params: [asOf],
  };
}

/** Invoice register (net/tax/grand/outstanding) for a party over a date range. */
function registerSql(doctype: string, partyField: string, f: Filters): { text: string; params: unknown[] } {
  const table = `tab${doctype}`;
  const params: unknown[] = [];
  const where: string[] = [`"docstatus" = 1`];
  if (f.from_date) { params.push(f.from_date); where.push(`"posting_date" >= $${params.length}`); }
  if (f.to_date) { params.push(f.to_date); where.push(`"posting_date" <= $${params.length}`); }
  return {
    text: `SELECT "name" AS "invoice", "${partyField}" AS "party", "posting_date",
                  "total"::float8 AS "net_total",
                  coalesce("total_taxes_and_charges", 0)::float8 AS "tax",
                  "grand_total"::float8 AS "grand_total",
                  coalesce("outstanding_amount", 0)::float8 AS "outstanding", "status"
           FROM "${table}" WHERE ${where.join(" AND ")}
           ORDER BY "posting_date", "name"`,
    params,
  };
}

@Controller("api/query-report")
export class QueryReportController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly permissions: PermissionService,
  ) {}

  @Get()
  list() {
    return {
      data: Object.entries(REPORTS).map(([name, r]) => ({
        name,
        columns: r.columns,
        filters: r.filters ?? [],
      })),
    };
  }

  @Get(":name")
  async run(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Query() query: Filters,
  ) {
    const report = REPORTS[name];
    if (!report) throw new NotFoundException(`Unknown report: ${name}`);
    await this.permissions.assertPerm(user, report.permDoctype, PermType.Report);
    const { text, params } = report.build
      ? report.build(query)
      : { text: report.sql as string, params: [] as unknown[] };
    const rows = await this.dataSource.query(text, params);
    return { data: { columns: report.columns, rows } };
  }
}
