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
  "stock-ageing": {
    permDoctype: "Bin",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "qty", label: "Qty" },
      { key: "stock_value", label: "Value" },
      { key: "last_movement", label: "Last Movement" },
      { key: "age_days", label: "Age (days)" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    // In-stock item/warehouse balances with the date of their last stock movement
    // and how many days ago that was — surfacing stagnant stock.
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT b."item_code", b."warehouse",
                      sum(b."actual_qty")::float8 AS "qty",
                      sum(b."stock_value")::float8 AS "stock_value",
                      max(sle."last")::text AS "last_movement",
                      ($1::date - max(sle."last"))::int AS "age_days"
               FROM "tabBin" b
               LEFT JOIN (
                 SELECT "item_code", "warehouse", max("posting_date") AS "last"
                 FROM "tabStock Ledger Entry" GROUP BY "item_code", "warehouse"
               ) sle ON sle."item_code" = b."item_code" AND sle."warehouse" = b."warehouse"
               GROUP BY b."item_code", b."warehouse"
               HAVING sum(b."actual_qty") <> 0
               ORDER BY "age_days" DESC NULLS LAST`,
        params: [asOf],
      };
    },
  },
  "slow-moving-items": {
    permDoctype: "Bin",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "qty", label: "Qty On Hand" },
      { key: "stock_value", label: "Value" },
      { key: "last_sale", label: "Last Sale" },
      { key: "days_since_sale", label: "Days Since Sale" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    // In-stock items ranked by how long since their last outbound (sale) movement;
    // items never sold sort to the top (null days).
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT b."item_code", b."warehouse",
                      sum(b."actual_qty")::float8 AS "qty",
                      sum(b."stock_value")::float8 AS "stock_value",
                      max(out."last")::text AS "last_sale",
                      ($1::date - max(out."last"))::int AS "days_since_sale"
               FROM "tabBin" b
               LEFT JOIN (
                 SELECT "item_code", "warehouse", max("posting_date") AS "last"
                 FROM "tabStock Ledger Entry" WHERE "actual_qty" < 0
                 GROUP BY "item_code", "warehouse"
               ) out ON out."item_code" = b."item_code" AND out."warehouse" = b."warehouse"
               GROUP BY b."item_code", b."warehouse"
               HAVING sum(b."actual_qty") > 0
               ORDER BY "days_since_sale" DESC NULLS FIRST`,
        params: [asOf],
      };
    },
  },
  "stock-value-by-group": {
    permDoctype: "Bin",
    columns: [
      { key: "item_group", label: "Item Group" },
      { key: "items", label: "Items" },
      { key: "qty", label: "Qty" },
      { key: "stock_value", label: "Stock Value" },
    ],
    // Total on-hand quantity and valuation per item group.
    sql: `SELECT coalesce(i."item_group", 'Unclassified') AS "item_group",
                 count(DISTINCT b."item_code")::int AS "items",
                 sum(b."actual_qty")::float8 AS "qty",
                 sum(b."stock_value")::float8 AS "stock_value"
          FROM "tabBin" b
          LEFT JOIN "tabItem" i ON i."name" = b."item_code"
          GROUP BY coalesce(i."item_group", 'Unclassified')
          HAVING sum(b."actual_qty") <> 0
          ORDER BY "stock_value" DESC`,
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
  "write-off-register": {
    permDoctype: "Write Off Entry",
    columns: [
      { key: "write_off", label: "Write Off" },
      { key: "posting_date", label: "Posting Date" },
      { key: "customer", label: "Customer" },
      { key: "sales_invoice", label: "Sales Invoice" },
      { key: "write_off_amount", label: "Amount" },
      { key: "write_off_account", label: "Account" },
      { key: "reason", label: "Reason" },
    ],
    // Submitted bad-debt write-offs.
    sql: `SELECT "name" AS "write_off", "posting_date", "customer", "sales_invoice",
                 coalesce("write_off_amount", 0)::float8 AS "write_off_amount",
                 coalesce("write_off_account", 'Bad Debt Expense') AS "write_off_account", "reason"
          FROM "tabWrite Off Entry"
          WHERE "docstatus" = 1
          ORDER BY "posting_date" DESC, "name"`,
  },
  "contra-entry-register": {
    permDoctype: "Contra Entry",
    columns: [
      { key: "contra_entry", label: "Contra Entry" },
      { key: "posting_date", label: "Posting Date" },
      { key: "from_account", label: "From" },
      { key: "to_account", label: "To" },
      { key: "amount", label: "Amount" },
      { key: "remark", label: "Remark" },
    ],
    // Submitted internal transfers between own accounts.
    sql: `SELECT "name" AS "contra_entry", "posting_date", "from_account", "to_account",
                 coalesce("amount", 0)::float8 AS "amount", "remark"
          FROM "tabContra Entry"
          WHERE "docstatus" = 1
          ORDER BY "posting_date" DESC, "name"`,
  },
  "cash-flow-statement": {
    permDoctype: "GL Entry",
    columns: [
      { key: "category", label: "Category" },
      { key: "inflow", label: "Inflow" },
      { key: "outflow", label: "Outflow" },
      { key: "net", label: "Net Cash Flow" },
    ],
    filters: [
      { fieldname: "from_date", label: "From", fieldtype: "Date" },
      { fieldname: "to_date", label: "To", fieldtype: "Date" },
    ],
    // Direct-method cash flow: movements on the Cash/Bank accounts, classified into
    // Operating / Investing / Financing by the voucher type that moved the cash.
    build: (f) => {
      const params: unknown[] = [];
      let range = "";
      if (f.from_date) { params.push(f.from_date); range += ` AND "posting_date" >= $${params.length}`; }
      if (f.to_date) { params.push(f.to_date); range += ` AND "posting_date" <= $${params.length}`; }
      const CATEGORY = `CASE
        WHEN "voucher_type" IN ('Asset','Depreciation Entry','Asset Disposal','Asset Repair','Asset Movement') THEN '2 - Investing'
        WHEN "voucher_type" IN ('Loan','Loan Repayment Entry','Gratuity','Commission Payout','Period Closing Voucher') THEN '3 - Financing'
        ELSE '1 - Operating' END`;
      return {
        text: `SELECT ${CATEGORY} AS "category",
                      sum("debit")::float8 AS "inflow",
                      sum("credit")::float8 AS "outflow",
                      (sum("debit") - sum("credit"))::float8 AS "net"
               FROM "tabGL Entry"
               WHERE "account" IN ('Cash','Bank')${range}
               GROUP BY ${CATEGORY}
               ORDER BY 1`,
        params,
      };
    },
  },
  "bank-cash-summary": {
    permDoctype: "GL Entry",
    columns: [
      { key: "account", label: "Account" },
      { key: "inflow", label: "Inflow" },
      { key: "outflow", label: "Outflow" },
      { key: "balance", label: "Balance" },
    ],
    // Per cash/bank account: total received, total paid, and current balance.
    sql: `SELECT "account",
                 sum("debit")::float8 AS "inflow",
                 sum("credit")::float8 AS "outflow",
                 (sum("debit") - sum("credit"))::float8 AS "balance"
          FROM "tabGL Entry"
          WHERE "account" IN ('Cash','Bank')
          GROUP BY "account"
          ORDER BY "account"`,
  },
  "cash-flow-forecast": {
    permDoctype: "Sales Invoice",
    columns: [
      { key: "bucket", label: "Due Window" },
      { key: "inflow", label: "Expected Inflow" },
      { key: "outflow", label: "Expected Outflow" },
      { key: "net", label: "Net" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    // Forward cash projection: open receivables (Sales Invoices) as inflows and open
    // payables (Purchase Invoices) as outflows, bucketed by how far off the due date is.
    build: (f) => {
      const asOf = f.as_of || today();
      const BUCKET = (due: string) => `CASE
        WHEN ${due} <= $1::date THEN '1 - Overdue'
        WHEN ${due} <= $1::date + 30 THEN '2 - 0-30 days'
        WHEN ${due} <= $1::date + 60 THEN '3 - 31-60 days'
        ELSE '4 - 60+ days' END`;
      return {
        text: `WITH flow AS (
                 SELECT ${BUCKET('"due_date"')} AS bucket,
                        coalesce("outstanding_amount", 0) AS inflow, 0 AS outflow
                 FROM "tabSales Invoice"
                 WHERE "docstatus" = 1 AND coalesce("outstanding_amount", 0) > 0
                 UNION ALL
                 SELECT ${BUCKET('"due_date"')} AS bucket,
                        0 AS inflow, coalesce("outstanding_amount", 0) AS outflow
                 FROM "tabPurchase Invoice"
                 WHERE "docstatus" = 1 AND coalesce("outstanding_amount", 0) > 0
               )
               SELECT bucket,
                      sum(inflow)::float8 AS "inflow",
                      sum(outflow)::float8 AS "outflow",
                      (sum(inflow) - sum(outflow))::float8 AS "net"
               FROM flow GROUP BY bucket ORDER BY bucket`,
        params: [asOf],
      };
    },
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
  "project-budget-variance": {
    permDoctype: "GL Entry",
    columns: [
      { key: "project", label: "Project" },
      { key: "account", label: "Account" },
      { key: "budget_amount", label: "Budget" },
      { key: "actual", label: "Actual" },
      { key: "variance", label: "Variance" },
    ],
    // Budget vs actual for project-dimension budgets: each Budget carrying a
    // project is matched to the GL actual (Dr − Cr) for that project + account.
    sql: `SELECT b."project", b."account",
                 b."budget_amount"::float8 AS "budget_amount",
                 coalesce(act."actual", 0)::float8 AS "actual",
                 (b."budget_amount" - coalesce(act."actual", 0))::float8 AS "variance"
          FROM "tabBudget" b
          LEFT JOIN (
            SELECT "account", "project", sum("debit") - sum("credit") AS "actual"
            FROM "tabGL Entry"
            WHERE "project" IS NOT NULL AND "project" <> ''
            GROUP BY "account", "project"
          ) act ON act."account" = b."account" AND act."project" = b."project"
          WHERE b."project" IS NOT NULL AND b."project" <> ''
          ORDER BY b."project", b."account"`,
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
  "campaign-performance": {
    permDoctype: "Lead",
    columns: [
      { key: "campaign", label: "Campaign" },
      { key: "leads", label: "Leads" },
      { key: "converted", label: "Converted" },
      { key: "conversion_rate", label: "Conversion %" },
    ],
    // Lead volume and conversion per campaign (a Lead is "converted" once its
    // customer back-link is stamped by the CRM pipeline listener).
    sql: `SELECT "campaign",
                 count(*)::float8 AS "leads",
                 count(*) FILTER (WHERE "customer" IS NOT NULL AND "customer" <> '')::float8 AS "converted",
                 (100.0 * count(*) FILTER (WHERE "customer" IS NOT NULL AND "customer" <> '')
                   / NULLIF(count(*), 0))::float8 AS "conversion_rate"
          FROM "tabLead"
          WHERE "campaign" IS NOT NULL AND "campaign" <> ''
          GROUP BY "campaign"
          ORDER BY "leads" DESC`,
  },
  "commission-payable": {
    permDoctype: "Sales Person",
    columns: [
      { key: "sales_person", label: "Sales Person" },
      { key: "accrued", label: "Accrued Commission" },
      { key: "paid", label: "Paid" },
      { key: "payable", label: "Outstanding Payable" },
    ],
    // Accrued vs paid commission per sales person; the balance is still owed.
    sql: `SELECT "name" AS "sales_person",
                 coalesce("total_commission", 0)::float8 AS "accrued",
                 coalesce("paid_commission", 0)::float8 AS "paid",
                 (coalesce("total_commission", 0) - coalesce("paid_commission", 0))::float8 AS "payable"
          FROM "tabSales Person"
          ORDER BY "payable" DESC`,
  },
  "sales-commission": {
    permDoctype: "Sales Person",
    columns: [
      { key: "sales_person", label: "Sales Person" },
      { key: "total_sales", label: "Total Sales" },
      { key: "commission_rate", label: "Rate %" },
      { key: "total_commission", label: "Commission" },
      { key: "target_amount", label: "Target" },
      { key: "attainment", label: "Attainment %" },
    ],
    // Per-person commission and target attainment, from the rollups the
    // Salesteam listener maintains on each Sales Invoice submit.
    sql: `SELECT "name" AS "sales_person",
                 coalesce("total_sales", 0)::float8 AS "total_sales",
                 coalesce("commission_rate", 0)::float8 AS "commission_rate",
                 coalesce("total_commission", 0)::float8 AS "total_commission",
                 coalesce("target_amount", 0)::float8 AS "target_amount",
                 (CASE WHEN coalesce("target_amount", 0) > 0
                       THEN 100.0 * coalesce("total_sales", 0) / "target_amount"
                       ELSE 0 END)::float8 AS "attainment"
          FROM "tabSales Person"
          ORDER BY "total_sales" DESC`,
  },
  "vehicle-running-cost": {
    permDoctype: "Vehicle Log",
    columns: [
      { key: "vehicle", label: "Vehicle" },
      { key: "fuel_cost", label: "Fuel Cost" },
      { key: "service_cost", label: "Service Cost" },
      { key: "distance", label: "Distance" },
      { key: "total_cost", label: "Total Cost" },
      { key: "cost_per_km", label: "Cost / km" },
    ],
    filters: [{ fieldname: "vehicle", label: "Vehicle", fieldtype: "Link" }],
    // Running cost per vehicle from its submitted logs: fuel + service, distance
    // (max − min odometer), and cost per distance unit.
    build: (f) => {
      const params: unknown[] = [];
      let clause = `WHERE "docstatus" = 1`;
      if (f.vehicle) { params.push(f.vehicle); clause += ` AND "vehicle" = $${params.length}`; }
      return {
        text: `SELECT "vehicle",
                      sum("fuel_cost")::float8 AS "fuel_cost",
                      sum("service_cost")::float8 AS "service_cost",
                      (max("odometer") - min("odometer"))::float8 AS "distance",
                      (sum("fuel_cost") + sum("service_cost"))::float8 AS "total_cost",
                      (CASE WHEN (max("odometer") - min("odometer")) > 0
                            THEN (sum("fuel_cost") + sum("service_cost")) / (max("odometer") - min("odometer"))
                            ELSE 0 END)::float8 AS "cost_per_km"
               FROM "tabVehicle Log" ${clause}
               GROUP BY "vehicle"
               ORDER BY "vehicle"`,
        params,
      };
    },
  },
  "attendance-summary": {
    permDoctype: "Attendance",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "present", label: "Present" },
      { key: "absent", label: "Absent" },
      { key: "half_day", label: "Half Day" },
      { key: "on_leave", label: "On Leave" },
      { key: "working_hours", label: "Total Hours" },
    ],
    filters: [
      { fieldname: "from_date", label: "From Date", fieldtype: "Date" },
      { fieldname: "to_date", label: "To Date", fieldtype: "Date" },
    ],
    build: (f) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (f.from_date) { params.push(f.from_date); where.push(`"attendance_date" >= $${params.length}`); }
      if (f.to_date) { params.push(f.to_date); where.push(`"attendance_date" <= $${params.length}`); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      return {
        text: `SELECT "employee",
                      count(*) FILTER (WHERE "status" = 'Present')::float8 AS "present",
                      count(*) FILTER (WHERE "status" = 'Absent')::float8 AS "absent",
                      count(*) FILTER (WHERE "status" = 'Half Day')::float8 AS "half_day",
                      count(*) FILTER (WHERE "status" = 'On Leave')::float8 AS "on_leave",
                      coalesce(sum("working_hours"), 0)::float8 AS "working_hours"
               FROM "tabAttendance" ${clause}
               GROUP BY "employee"
               ORDER BY "employee"`,
        params,
      };
    },
  },
  "tds-payable": {
    permDoctype: "GL Entry",
    columns: [
      { key: "supplier", label: "Supplier" },
      { key: "account", label: "TDS Account" },
      { key: "tds", label: "Tax Withheld" },
    ],
    // Tax withheld per supplier: the credit side of each Purchase Invoice's TDS
    // lines. The GL against-field carries the supplier; TDS credits a liability.
    sql: `SELECT "against" AS "supplier", "account", sum("credit")::float8 AS "tds"
          FROM "tabGL Entry"
          WHERE "voucher_type" = 'Purchase Invoice' AND "account" LIKE 'TDS%' AND "credit" > 0
          GROUP BY "against", "account"
          ORDER BY "against"`,
  },
  "projected-qty": {
    permDoctype: "Bin",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "actual", label: "On Hand" },
      { key: "reserved", label: "Reserved" },
      { key: "projected", label: "Projected" },
    ],
    // On-hand from Bin, reserved from submitted Stock Reservations; projected is
    // what is free to promise (on hand minus reserved).
    sql: `SELECT b."item_code", b."warehouse",
                 sum(b."actual_qty")::float8 AS "actual",
                 coalesce(r."reserved", 0)::float8 AS "reserved",
                 (sum(b."actual_qty") - coalesce(r."reserved", 0))::float8 AS "projected"
          FROM "tabBin" b
          LEFT JOIN (
            SELECT "item_code", "warehouse", sum("qty") AS "reserved"
            FROM "tabStock Reservation" WHERE "docstatus" = 1
            GROUP BY "item_code", "warehouse"
          ) r ON r."item_code" = b."item_code" AND r."warehouse" = b."warehouse"
          GROUP BY b."item_code", b."warehouse", r."reserved"
          HAVING sum(b."actual_qty") <> 0 OR coalesce(r."reserved", 0) <> 0
          ORDER BY b."item_code", b."warehouse"`,
  },
  "party-contacts": {
    permDoctype: "Contact",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "contact", label: "Contact" },
      { key: "email_id", label: "Email" },
      { key: "mobile_no", label: "Mobile" },
      { key: "is_primary", label: "Primary" },
    ],
    filters: [{ fieldname: "customer", label: "Customer", fieldtype: "Link" }],
    build: (f) => {
      const params: unknown[] = [];
      let clause = `WHERE "customer" IS NOT NULL AND "customer" <> ''`;
      if (f.customer) { params.push(f.customer); clause += ` AND "customer" = $${params.length}`; }
      return {
        text: `SELECT "customer",
                      trim(concat("first_name", ' ', coalesce("last_name", ''))) AS "contact",
                      "email_id", "mobile_no",
                      (CASE WHEN "is_primary" = 1 THEN 'Yes' ELSE '' END) AS "is_primary"
               FROM "tabContact" ${clause}
               ORDER BY "customer", "is_primary" DESC, "first_name"`,
        params,
      };
    },
  },
  "deferred-revenue": {
    permDoctype: "Deferred Revenue Schedule",
    columns: [
      { key: "schedule", label: "Schedule" },
      { key: "customer", label: "Customer" },
      { key: "total_amount", label: "Total" },
      { key: "recognized_amount", label: "Recognized" },
      { key: "deferred", label: "Deferred (remaining)" },
      { key: "status", label: "Status" },
    ],
    // Remaining deferred balance per submitted schedule (total − recognized).
    sql: `SELECT "name" AS "schedule", "customer",
                 "total_amount"::float8 AS "total_amount",
                 coalesce("recognized_amount", 0)::float8 AS "recognized_amount",
                 ("total_amount" - coalesce("recognized_amount", 0))::float8 AS "deferred",
                 "status"
          FROM "tabDeferred Revenue Schedule"
          WHERE "docstatus" = 1
          ORDER BY "name"`,
  },
  "inventory-valuation": {
    permDoctype: "Bin",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "qty", label: "Qty" },
      { key: "valuation_rate", label: "Valuation Rate" },
      { key: "stock_value", label: "Stock Value" },
      { key: "stock_in_hand_gl", label: "Stock In Hand (GL)" },
    ],
    // Per-item Bin stock value alongside the Stock In Hand GL balance, so the
    // physical ledger can be reconciled against the accounting balance. The GL
    // figure (same on every row) is the running Dr − Cr of the Stock In Hand account.
    sql: `SELECT b."item_code", b."warehouse",
                 sum(b."actual_qty")::float8 AS "qty",
                 (CASE WHEN sum(b."actual_qty") <> 0
                       THEN sum(b."stock_value") / sum(b."actual_qty") ELSE 0 END)::float8 AS "valuation_rate",
                 sum(b."stock_value")::float8 AS "stock_value",
                 (SELECT coalesce(sum("debit") - sum("credit"), 0)
                    FROM "tabGL Entry" WHERE "account" = 'Stock In Hand')::float8 AS "stock_in_hand_gl"
          FROM "tabBin" b
          GROUP BY b."item_code", b."warehouse"
          HAVING sum(b."actual_qty") <> 0
          ORDER BY b."item_code", b."warehouse"`,
  },
  "payroll-register": {
    permDoctype: "Salary Slip",
    columns: [
      { key: "slip", label: "Salary Slip" },
      { key: "employee", label: "Employee" },
      { key: "posting_date", label: "Posting Date" },
      { key: "gross_pay", label: "Gross Pay" },
      { key: "total_deduction", label: "Deduction" },
      { key: "net_pay", label: "Net Pay" },
      { key: "payroll_entry", label: "Payroll Entry" },
    ],
    filters: [{ fieldname: "payroll_entry", label: "Payroll Entry", fieldtype: "Link" }],
    // Submitted salary slips with pay breakdown, optionally scoped to a payroll run.
    build: (f) => {
      const params: unknown[] = [];
      let clause = `WHERE "docstatus" = 1`;
      if (f.payroll_entry) { params.push(f.payroll_entry); clause += ` AND "payroll_entry" = $${params.length}`; }
      return {
        text: `SELECT "name" AS "slip", "employee", "posting_date",
                      coalesce("gross_pay", 0)::float8 AS "gross_pay",
                      coalesce("total_deduction", 0)::float8 AS "total_deduction",
                      coalesce("net_pay", 0)::float8 AS "net_pay", "payroll_entry"
               FROM "tabSalary Slip" ${clause}
               ORDER BY "payroll_entry", "employee"`,
        params,
      };
    },
  },
  "recurring-journal-status": {
    permDoctype: "Recurring Journal",
    columns: [
      { key: "recurring_journal", label: "Template" },
      { key: "title", label: "Title" },
      { key: "frequency", label: "Frequency" },
      { key: "next_date", label: "Next Posting Date" },
      { key: "enabled", label: "Enabled" },
      { key: "entries", label: "Entries Posted" },
    ],
    // Each recurring-journal template with its schedule and the count of Journal
    // Entries it has posted so far.
    sql: `SELECT r."name" AS "recurring_journal", r."title", r."frequency",
                 r."next_date", coalesce(r."enabled", 0)::int AS "enabled",
                 (SELECT count(*) FROM "tabJournal Entry" j
                  WHERE j."recurring_journal" = r."name" AND j."docstatus" = 1)::int AS "entries"
          FROM "tabRecurring Journal" r
          ORDER BY r."name"`,
  },
  "accounting-period-status": {
    permDoctype: "Accounting Period",
    columns: [
      { key: "period_name", label: "Period" },
      { key: "from_date", label: "From" },
      { key: "to_date", label: "To" },
      { key: "is_closed", label: "Closed" },
      { key: "entries", label: "GL Entries" },
    ],
    // Each accounting period with its lock state and the count of GL entries posted in range.
    sql: `SELECT p."period_name", p."from_date", p."to_date",
                 coalesce(p."is_closed", 0)::int AS "is_closed",
                 (SELECT count(*) FROM "tabGL Entry" g
                  WHERE g."posting_date" >= p."from_date" AND g."posting_date" <= p."to_date")::int AS "entries"
          FROM "tabAccounting Period" p
          ORDER BY p."from_date"`,
  },
  "budget-utilization": {
    permDoctype: "Budget",
    columns: [
      { key: "cost_center", label: "Cost Center" },
      { key: "account", label: "Account" },
      { key: "budget_amount", label: "Budget" },
      { key: "actual", label: "Actual" },
      { key: "remaining", label: "Remaining" },
      { key: "percent_used", label: "% Used" },
      { key: "action", label: "Action" },
    ],
    // Budget vs actual (Σ GL Dr − Cr) per account + cost center, with % used and
    // the configured over-budget action.
    sql: `SELECT b."cost_center", b."account",
                 b."budget_amount"::float8 AS "budget_amount",
                 coalesce(act."actual", 0)::float8 AS "actual",
                 (b."budget_amount" - coalesce(act."actual", 0))::float8 AS "remaining",
                 (CASE WHEN b."budget_amount" <> 0
                       THEN round(coalesce(act."actual", 0) / b."budget_amount" * 100, 1)
                       ELSE 0 END)::float8 AS "percent_used",
                 coalesce(b."action_if_annual_budget_exceeded", 'Warn') AS "action"
          FROM "tabBudget" b
          LEFT JOIN (
            SELECT "account", "cost_center", sum("debit") - sum("credit") AS "actual"
            FROM "tabGL Entry" GROUP BY "account", "cost_center"
          ) act ON act."account" = b."account" AND act."cost_center" = b."cost_center"
          WHERE b."cost_center" IS NOT NULL AND b."cost_center" <> ''
          ORDER BY b."cost_center", b."account"`,
  },
  "asset-depreciation-schedule": {
    permDoctype: "Asset",
    columns: [
      { key: "asset", label: "Asset" },
      { key: "gross", label: "Gross" },
      { key: "salvage", label: "Salvage" },
      { key: "monthly", label: "Monthly Charge" },
      { key: "accumulated", label: "Accumulated" },
      { key: "current_value", label: "Current Value" },
      { key: "last_depreciation_date", label: "Last Run" },
      { key: "status", label: "Status" },
    ],
    // Depreciation position per submitted asset, with the straight-line monthly charge.
    sql: `SELECT "name" AS "asset",
                 "gross_purchase_amount"::float8 AS "gross",
                 coalesce("salvage_value", 0)::float8 AS "salvage",
                 (CASE WHEN coalesce("useful_life_years", 0) > 0
                       THEN round((("gross_purchase_amount" - coalesce("salvage_value", 0)) / "useful_life_years" / 12)::numeric, 2)
                       ELSE 0 END)::float8 AS "monthly",
                 coalesce("accumulated_depreciation", 0)::float8 AS "accumulated",
                 coalesce("value_after_depreciation", "gross_purchase_amount")::float8 AS "current_value",
                 "last_depreciation_date", "status"
          FROM "tabAsset"
          WHERE "docstatus" = 1
          ORDER BY "name"`,
  },
  "gratuity-summary": {
    permDoctype: "Gratuity",
    columns: [
      { key: "gratuity", label: "Gratuity" },
      { key: "employee", label: "Employee" },
      { key: "relieving_date", label: "Relieving Date" },
      { key: "service_years", label: "Service Years" },
      { key: "monthly_salary", label: "Monthly Salary" },
      { key: "gratuity_amount", label: "Gratuity Amount" },
      { key: "status", label: "Status" },
    ],
    // End-of-service gratuity provisioned per submitted voucher.
    sql: `SELECT "name" AS "gratuity", "employee", "relieving_date",
                 coalesce("service_years", 0)::float8 AS "service_years",
                 coalesce("monthly_salary", 0)::float8 AS "monthly_salary",
                 coalesce("gratuity_amount", 0)::float8 AS "gratuity_amount", "status"
          FROM "tabGratuity"
          WHERE "docstatus" = 1
          ORDER BY "relieving_date", "name"`,
  },
  "loan-outstanding": {
    permDoctype: "Loan",
    columns: [
      { key: "loan", label: "Loan" },
      { key: "employee", label: "Employee" },
      { key: "loan_amount", label: "Loan Amount" },
      { key: "repaid_principal", label: "Principal Repaid" },
      { key: "outstanding", label: "Outstanding" },
      { key: "interest_paid", label: "Interest Collected" },
      { key: "status", label: "Status" },
    ],
    // Outstanding principal per disbursed loan (loan amount − principal repaid).
    sql: `SELECT "name" AS "loan", "employee",
                 "loan_amount"::float8 AS "loan_amount",
                 coalesce("repaid_principal", 0)::float8 AS "repaid_principal",
                 ("loan_amount" - coalesce("repaid_principal", 0))::float8 AS "outstanding",
                 coalesce("interest_paid", 0)::float8 AS "interest_paid", "status"
          FROM "tabLoan"
          WHERE "docstatus" = 1
          ORDER BY "name"`,
  },
  "loan-repayment-schedule": {
    permDoctype: "Loan",
    columns: [
      { key: "loan", label: "Loan" },
      { key: "employee", label: "Employee" },
      { key: "due_date", label: "Due Date" },
      { key: "principal", label: "Principal" },
      { key: "interest", label: "Interest" },
      { key: "total_payment", label: "Total Payment" },
      { key: "balance", label: "Outstanding After" },
    ],
    filters: [{ fieldname: "loan", label: "Loan", fieldtype: "Link" }],
    // Amortisation schedule (principal + reducing-balance interest) per submitted loan.
    build: (f) => {
      const params: unknown[] = [];
      let clause = `WHERE l."docstatus" = 1`;
      if (f.loan) { params.push(f.loan); clause += ` AND l."name" = $${params.length}`; }
      return {
        text: `SELECT l."name" AS "loan", l."employee", r."due_date",
                      r."principal"::float8 AS "principal",
                      r."interest"::float8 AS "interest",
                      r."total_payment"::float8 AS "total_payment",
                      r."balance"::float8 AS "balance"
               FROM "tabLoan" l
               JOIN "tabLoan Repayment" r ON r."parent" = l."name"
               ${clause}
               ORDER BY l."name", r."due_date"`,
        params,
      };
    },
  },
  "sales-pipeline": {
    permDoctype: "Opportunity",
    columns: [
      { key: "sales_stage", label: "Sales Stage" },
      { key: "opportunities", label: "Opportunities" },
      { key: "amount", label: "Total Amount" },
      { key: "weighted_amount", label: "Weighted (Forecast)" },
    ],
    // Live pipeline by stage: open (non-closed) opportunities only, with the
    // weighted forecast summed per stage.
    sql: `SELECT coalesce("sales_stage", 'Prospecting') AS "sales_stage",
                 count(*)::int AS "opportunities",
                 coalesce(sum("opportunity_amount"), 0)::float8 AS "amount",
                 coalesce(sum("weighted_amount"), 0)::float8 AS "weighted_amount"
          FROM "tabOpportunity"
          WHERE coalesce("sales_stage", 'Prospecting') NOT IN ('Closed Won', 'Closed Lost')
            AND coalesce("status", 'Open') NOT IN ('Lost', 'Closed')
          GROUP BY coalesce("sales_stage", 'Prospecting')
          ORDER BY 1`,
  },
  "exchange-rate-revaluation": {
    permDoctype: "Exchange Rate Revaluation",
    columns: [
      { key: "revaluation", label: "Revaluation" },
      { key: "posting_date", label: "Posting Date" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "balance", label: "Balance" },
      { key: "current_exchange_rate", label: "Current Rate" },
      { key: "new_exchange_rate", label: "New Rate" },
      { key: "gain_loss", label: "Gain / Loss" },
    ],
    // Per-account revaluation detail for each submitted revaluation voucher.
    sql: `SELECT r."name" AS "revaluation", r."posting_date",
                 a."account", a."party",
                 a."balance"::float8 AS "balance",
                 a."current_exchange_rate"::float8 AS "current_exchange_rate",
                 a."new_exchange_rate"::float8 AS "new_exchange_rate",
                 coalesce(a."gain_loss", 0)::float8 AS "gain_loss"
          FROM "tabExchange Rate Revaluation" r
          JOIN "tabExchange Rate Revaluation Account" a ON a."parent" = r."name"
          WHERE r."docstatus" = 1
          ORDER BY r."posting_date", r."name", a."account"`,
  },
  "supplier-scorecard": {
    permDoctype: "Supplier Scorecard",
    columns: [
      { key: "supplier", label: "Supplier" },
      { key: "evaluation_date", label: "Last Evaluated" },
      { key: "total_score", label: "Score" },
      { key: "standing", label: "Standing" },
    ],
    // Each supplier's most recent submitted scorecard (via DISTINCT ON).
    sql: `SELECT DISTINCT ON ("supplier")
                 "supplier", "evaluation_date",
                 coalesce("total_score", 0)::float8 AS "total_score", "standing"
          FROM "tabSupplier Scorecard"
          WHERE "docstatus" = 1
          ORDER BY "supplier", "evaluation_date" DESC, "creation" DESC`,
  },
  "payment-mode-summary": {
    permDoctype: "Payment Entry",
    columns: [
      { key: "mode_of_payment", label: "Mode of Payment" },
      { key: "count", label: "# Payments" },
      { key: "received", label: "Received" },
      { key: "paid", label: "Paid" },
      { key: "net", label: "Net" },
    ],
    // Submitted payments grouped by mode: received (Receive) vs paid (Pay).
    sql: `SELECT coalesce(NULLIF("mode_of_payment", ''), '(none)') AS "mode_of_payment",
                 count(*)::float8 AS "count",
                 sum(CASE WHEN "payment_type" = 'Receive' THEN "base_paid_amount" ELSE 0 END)::float8 AS "received",
                 sum(CASE WHEN "payment_type" = 'Pay' THEN "base_paid_amount" ELSE 0 END)::float8 AS "paid",
                 sum(CASE WHEN "payment_type" = 'Receive' THEN "base_paid_amount" ELSE -"base_paid_amount" END)::float8 AS "net"
          FROM "tabPayment Entry"
          WHERE "docstatus" = 1
          GROUP BY coalesce(NULLIF("mode_of_payment", ''), '(none)')
          ORDER BY "mode_of_payment"`,
  },
  "journal-register": {
    permDoctype: "Journal Entry",
    columns: [
      { key: "entry", label: "Journal Entry" },
      { key: "posting_date", label: "Date" },
      { key: "user_remark", label: "Remark" },
      { key: "total_debit", label: "Debit" },
      { key: "total_credit", label: "Credit" },
    ],
    filters: [
      { fieldname: "from_date", label: "From Date", fieldtype: "Date" },
      { fieldname: "to_date", label: "To Date", fieldtype: "Date" },
    ],
    build: (f) => {
      const params: unknown[] = [];
      const where: string[] = [`"docstatus" = 1`];
      if (f.from_date) { params.push(f.from_date); where.push(`"posting_date" >= $${params.length}`); }
      if (f.to_date) { params.push(f.to_date); where.push(`"posting_date" <= $${params.length}`); }
      return {
        text: `SELECT "name" AS "entry", "posting_date", "user_remark",
                      coalesce("total_debit", 0)::float8 AS "total_debit",
                      coalesce("total_credit", 0)::float8 AS "total_credit"
               FROM "tabJournal Entry"
               WHERE ${where.join(" AND ")}
               ORDER BY "posting_date", "name"`,
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
      { fieldname: "project", label: "Project", fieldtype: "Link" },
      { fieldname: "from_date", label: "From Date", fieldtype: "Date" },
      { fieldname: "to_date", label: "To Date", fieldtype: "Date" },
    ],
    build: (f) => {
      const params: unknown[] = [];
      const where: string[] = [];
      if (f.account) { params.push(f.account); where.push(`"account" = $${params.length}`); }
      if (f.party) { params.push(f.party); where.push(`"against" = $${params.length}`); }
      if (f.project) { params.push(f.project); where.push(`"project" = $${params.length}`); }
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
  "project-ledger": {
    permDoctype: "GL Entry",
    columns: [
      { key: "project", label: "Project" },
      { key: "account", label: "Account" },
      { key: "debit", label: "Debit" },
      { key: "credit", label: "Credit" },
      { key: "net", label: "Net (Dr − Cr)" },
    ],
    filters: [{ fieldname: "project", label: "Project", fieldtype: "Link" }],
    // Dimension-wise ledger: GL rolled up by project + account. Only entries that
    // carry the project dimension are included.
    build: (f) => {
      const params: unknown[] = [];
      let clause = `WHERE "project" IS NOT NULL AND "project" <> ''`;
      if (f.project) { params.push(f.project); clause += ` AND "project" = $${params.length}`; }
      return {
        text: `SELECT "project", "account",
                      sum("debit")::float8 AS "debit",
                      sum("credit")::float8 AS "credit",
                      (sum("debit") - sum("credit"))::float8 AS "net"
               FROM "tabGL Entry" ${clause}
               GROUP BY "project", "account"
               ORDER BY "project", "account"`,
        params,
      };
    },
  },
  "project-progress": {
    permDoctype: "Project",
    columns: [
      { key: "project", label: "Project" },
      { key: "status", label: "Status" },
      { key: "total_tasks", label: "Tasks" },
      { key: "completed_tasks", label: "Completed" },
      { key: "open_tasks", label: "Open" },
      { key: "avg_progress", label: "Avg Progress (%)" },
      { key: "percent_complete", label: "% Complete" },
    ],
    filters: [{ fieldname: "project", label: "Project", fieldtype: "Link" }],
    // Per-project task rollup: counts by status and average task progress
    // alongside the stored percent_complete (maintained by TaskListener).
    build: (f) => {
      const params: unknown[] = [];
      let clause = "";
      if (f.project) { params.push(f.project); clause = `WHERE p."name" = $${params.length}`; }
      return {
        text: `SELECT p."name" AS "project", p."status" AS "status",
                      count(t."name")::int AS "total_tasks",
                      count(t."name") FILTER (WHERE t."status" = 'Completed')::int AS "completed_tasks",
                      count(t."name") FILTER (WHERE coalesce(t."status", 'Open') NOT IN ('Completed', 'Cancelled'))::int AS "open_tasks",
                      coalesce(round(avg(coalesce(t."progress", 0))::numeric, 2), 0)::float8 AS "avg_progress",
                      coalesce(p."percent_complete", 0)::float8 AS "percent_complete"
               FROM "tabProject" p
               LEFT JOIN "tabTask" t ON t."project" = p."name"
               ${clause}
               GROUP BY p."name", p."status", p."percent_complete"
               ORDER BY p."name"`,
        params,
      };
    },
  },
  "employee-advance-summary": {
    permDoctype: "Employee Advance",
    columns: [
      { key: "advance", label: "Advance" },
      { key: "employee", label: "Employee" },
      { key: "posting_date", label: "Date" },
      { key: "advance_amount", label: "Paid" },
      { key: "claimed_amount", label: "Claimed" },
      { key: "balance", label: "Balance" },
      { key: "status", label: "Status" },
    ],
    filters: [{ fieldname: "employee", label: "Employee", fieldtype: "Link" }],
    // Per submitted advance: amount paid, claimed against it, and the balance the
    // employee still owes back (paid − claimed).
    build: (f) => {
      const params: unknown[] = [];
      let clause = `WHERE "docstatus" = 1`;
      if (f.employee) { params.push(f.employee); clause += ` AND "employee" = $${params.length}`; }
      return {
        text: `SELECT "name" AS "advance", "employee", "posting_date",
                      "advance_amount"::float8 AS "advance_amount",
                      coalesce("claimed_amount", 0)::float8 AS "claimed_amount",
                      ("advance_amount" - coalesce("claimed_amount", 0))::float8 AS "balance",
                      "status"
               FROM "tabEmployee Advance" ${clause}
               ORDER BY "employee", "posting_date", "name"`,
        params,
      };
    },
  },
  "top-selling-items": {
    permDoctype: "Sales Invoice",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "qty", label: "Qty Sold" },
      { key: "revenue", label: "Revenue" },
    ],
    // Quantity and revenue per item across submitted (non-return) Sales Invoices.
    sql: `SELECT si_item."item_code",
                 sum(si_item."qty")::float8 AS "qty",
                 sum(coalesce(si_item."amount", 0))::float8 AS "revenue"
          FROM "tabSales Invoice Item" si_item
          JOIN "tabSales Invoice" si ON si."name" = si_item."parent"
          WHERE si."docstatus" = 1 AND coalesce(si."is_return", 0) = 0
          GROUP BY si_item."item_code"
          ORDER BY "revenue" DESC`,
  },
  "customer-revenue": {
    permDoctype: "Sales Invoice",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "invoices", label: "Invoices" },
      { key: "revenue", label: "Revenue" },
      { key: "outstanding", label: "Outstanding" },
    ],
    // Per customer: invoice count, total billed, and total outstanding.
    sql: `SELECT "customer",
                 count(*)::int AS "invoices",
                 sum(coalesce("grand_total", "total", 0))::float8 AS "revenue",
                 sum(coalesce("outstanding_amount", 0))::float8 AS "outstanding"
          FROM "tabSales Invoice"
          WHERE "docstatus" = 1 AND coalesce("is_return", 0) = 0
          GROUP BY "customer"
          ORDER BY "revenue" DESC`,
  },
  "gross-profit": {
    permDoctype: "Sales Invoice",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "revenue", label: "Revenue" },
      { key: "cost", label: "Cost" },
      { key: "gross_profit", label: "Gross Profit" },
      { key: "margin_pct", label: "Margin %" },
    ],
    // Revenue vs cost per item, costing sold quantity at the item's average Bin
    // (moving-average) valuation; margin % = gross profit / revenue.
    sql: `WITH cost AS (
            SELECT "item_code", avg("valuation_rate") AS rate
            FROM "tabBin" GROUP BY "item_code"
          ), sold AS (
            SELECT si_item."item_code",
                   sum(si_item."qty") AS qty,
                   sum(coalesce(si_item."amount", 0)) AS revenue
            FROM "tabSales Invoice Item" si_item
            JOIN "tabSales Invoice" si ON si."name" = si_item."parent"
            WHERE si."docstatus" = 1 AND coalesce(si."is_return", 0) = 0
            GROUP BY si_item."item_code"
          )
          SELECT s."item_code",
                 s.revenue::float8 AS "revenue",
                 (s.qty * coalesce(c.rate, 0))::float8 AS "cost",
                 (s.revenue - s.qty * coalesce(c.rate, 0))::float8 AS "gross_profit",
                 (CASE WHEN s.revenue <> 0
                       THEN round(((s.revenue - s.qty * coalesce(c.rate, 0)) / s.revenue * 100)::numeric, 1)
                       ELSE 0 END)::float8 AS "margin_pct"
          FROM sold s LEFT JOIN cost c ON c."item_code" = s."item_code"
          ORDER BY "gross_profit" DESC`,
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
  "lead-conversion": {
    permDoctype: "Lead",
    columns: [
      { key: "lead", label: "Lead" },
      { key: "lead_name", label: "Name" },
      { key: "status", label: "Status" },
      { key: "campaign", label: "Campaign" },
      { key: "customer", label: "Customer" },
      { key: "opportunity", label: "Opportunity" },
    ],
    // Each lead with its funnel progress: converted customer and opportunity links.
    sql: `SELECT "name" AS "lead", "lead_name", coalesce("status", 'Open') AS "status",
                 "campaign", "customer", "opportunity"
          FROM "tabLead"
          ORDER BY "name"`,
  },
  "customer-credit-exposure": {
    permDoctype: "Customer",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "credit_limit", label: "Credit Limit" },
      { key: "open_receivable", label: "Open Receivable" },
      { key: "unbilled_orders", label: "Unbilled Orders" },
      { key: "exposure", label: "Exposure" },
      { key: "available", label: "Available" },
    ],
    // Per customer with a credit limit: open sales-invoice receivable plus the
    // un-billed backlog of submitted Sales Orders, the resulting total exposure,
    // and the headroom left against the limit (negative = over limit).
    sql: `WITH recv AS (
            SELECT "customer", coalesce(sum("outstanding_amount"), 0)::float8 AS amt
            FROM "tabSales Invoice" WHERE "docstatus" = 1 GROUP BY "customer"
          ), so AS (
            SELECT "customer", coalesce(sum(
                     coalesce("grand_total", "total", 0)
                     * greatest(0, least(1, 1 - coalesce("per_billed", 0) / 100.0))
                   ), 0)::float8 AS amt
            FROM "tabSales Order" WHERE "docstatus" = 1 GROUP BY "customer"
          )
          SELECT c."name" AS "customer",
                 coalesce(c."credit_limit", 0)::float8 AS "credit_limit",
                 coalesce(recv.amt, 0) AS "open_receivable",
                 coalesce(so.amt, 0) AS "unbilled_orders",
                 (coalesce(recv.amt, 0) + coalesce(so.amt, 0)) AS "exposure",
                 (coalesce(c."credit_limit", 0)::float8 - coalesce(recv.amt, 0) - coalesce(so.amt, 0)) AS "available"
          FROM "tabCustomer" c
          LEFT JOIN recv ON recv."customer" = c."name"
          LEFT JOIN so ON so."customer" = c."name"
          WHERE coalesce(c."credit_limit", 0) > 0
          ORDER BY "exposure" DESC, c."name"`,
  },
  "material-request-status": {
    permDoctype: "Material Request",
    columns: [
      { key: "material_request", label: "Material Request" },
      { key: "material_request_type", label: "Type" },
      { key: "transaction_date", label: "Date" },
      { key: "total_qty", label: "Total Qty" },
      { key: "ordered_qty", label: "Ordered Qty" },
      { key: "status", label: "Status" },
      { key: "purchase_order", label: "Purchase Order" },
    ],
    // Submitted material requests with their requested vs ordered quantities and status.
    sql: `SELECT m."name" AS "material_request", m."material_request_type", m."transaction_date",
                 coalesce(sum(i."qty"), 0)::float8 AS "total_qty",
                 coalesce(sum(i."ordered_qty"), 0)::float8 AS "ordered_qty",
                 coalesce(m."status", 'Pending') AS "status", m."purchase_order"
          FROM "tabMaterial Request" m
          LEFT JOIN "tabMaterial Request Item" i ON i."parent" = m."name"
          WHERE m."docstatus" = 1
          GROUP BY m."name", m."material_request_type", m."transaction_date", m."status", m."purchase_order"
          ORDER BY m."transaction_date" DESC, m."name"`,
  },
  "receipt-return-register": {
    permDoctype: "Purchase Receipt",
    columns: [
      { key: "return_receipt", label: "Return Receipt" },
      { key: "supplier", label: "Supplier" },
      { key: "posting_date", label: "Posting Date" },
      { key: "return_against", label: "Return Against" },
      { key: "returned_qty", label: "Returned Qty" },
      { key: "total", label: "Return Value" },
    ],
    // Submitted return purchase receipts (goods sent back to the supplier).
    sql: `SELECT p."name" AS "return_receipt", p."supplier", p."posting_date", p."return_against",
                 coalesce(sum(i."qty"), 0)::float8 AS "returned_qty",
                 coalesce(p."total", 0)::float8 AS "total"
          FROM "tabPurchase Receipt" p
          LEFT JOIN "tabPurchase Receipt Item" i ON i."parent" = p."name"
          WHERE p."docstatus" = 1 AND coalesce(p."is_return", 0) = 1
          GROUP BY p."name", p."supplier", p."posting_date", p."return_against", p."total"
          ORDER BY p."posting_date" DESC, p."name"`,
  },
  "debit-note-register": {
    permDoctype: "Purchase Invoice",
    columns: [
      { key: "debit_note", label: "Debit Note" },
      { key: "supplier", label: "Supplier" },
      { key: "posting_date", label: "Posting Date" },
      { key: "return_against", label: "Return Against" },
      { key: "total", label: "Return Value" },
      { key: "outstanding", label: "Outstanding" },
      { key: "status", label: "Status" },
    ],
    // Submitted debit notes (return purchase invoices) with the bill they reverse.
    sql: `SELECT "name" AS "debit_note", "supplier", "posting_date", "return_against",
                 coalesce("grand_total", "total", 0)::float8 AS "total",
                 coalesce("outstanding_amount", 0)::float8 AS "outstanding",
                 coalesce("status", 'Return') AS "status"
          FROM "tabPurchase Invoice"
          WHERE "docstatus" = 1 AND coalesce("is_return", 0) = 1
          ORDER BY "posting_date" DESC, "name"`,
  },
  "delivery-return-register": {
    permDoctype: "Delivery Note",
    columns: [
      { key: "return_delivery", label: "Return Delivery" },
      { key: "customer", label: "Customer" },
      { key: "posting_date", label: "Posting Date" },
      { key: "return_against", label: "Return Against" },
      { key: "returned_qty", label: "Returned Qty" },
      { key: "total", label: "Return Value" },
    ],
    // Submitted return delivery notes (goods received back) with their source delivery.
    sql: `SELECT d."name" AS "return_delivery", d."customer", d."posting_date", d."return_against",
                 coalesce(sum(i."qty"), 0)::float8 AS "returned_qty",
                 coalesce(d."total", 0)::float8 AS "total"
          FROM "tabDelivery Note" d
          LEFT JOIN "tabDelivery Note Item" i ON i."parent" = d."name"
          WHERE d."docstatus" = 1 AND coalesce(d."is_return", 0) = 1
          GROUP BY d."name", d."customer", d."posting_date", d."return_against", d."total"
          ORDER BY d."posting_date" DESC, d."name"`,
  },
  "credit-note-register": {
    permDoctype: "Sales Invoice",
    columns: [
      { key: "credit_note", label: "Credit Note" },
      { key: "customer", label: "Customer" },
      { key: "posting_date", label: "Posting Date" },
      { key: "return_against", label: "Return Against" },
      { key: "total", label: "Return Value" },
      { key: "outstanding", label: "Outstanding" },
      { key: "status", label: "Status" },
    ],
    // Submitted credit notes (return sales invoices) with the invoice they reverse.
    sql: `SELECT "name" AS "credit_note", "customer", "posting_date", "return_against",
                 coalesce("grand_total", "total", 0)::float8 AS "total",
                 coalesce("outstanding_amount", 0)::float8 AS "outstanding",
                 coalesce("status", 'Return') AS "status"
          FROM "tabSales Invoice"
          WHERE "docstatus" = 1 AND coalesce("is_return", 0) = 1
          ORDER BY "posting_date" DESC, "name"`,
  },
  "payment-entry-register": {
    permDoctype: "Payment Entry",
    columns: [
      { key: "payment_entry", label: "Payment Entry" },
      { key: "posting_date", label: "Posting Date" },
      { key: "payment_type", label: "Type" },
      { key: "party", label: "Party" },
      { key: "paid_amount", label: "Paid Amount" },
      { key: "allocated", label: "Allocated" },
      { key: "mode_of_payment", label: "Mode" },
    ],
    // Submitted payment entries with the total they allocated across referenced invoices.
    sql: `SELECT p."name" AS "payment_entry", p."posting_date", p."payment_type", p."party",
                 coalesce(p."paid_amount", 0)::float8 AS "paid_amount",
                 coalesce(sum(r."allocated_amount"), 0)::float8 AS "allocated",
                 p."mode_of_payment"
          FROM "tabPayment Entry" p
          LEFT JOIN "tabPayment Entry Reference" r ON r."parent" = p."name"
          WHERE p."docstatus" = 1
          GROUP BY p."name", p."posting_date", p."payment_type", p."party", p."paid_amount", p."mode_of_payment"
          ORDER BY p."posting_date" DESC, p."name"`,
  },
  "receipt-billing-status": {
    permDoctype: "Purchase Receipt",
    columns: [
      { key: "purchase_receipt", label: "Purchase Receipt" },
      { key: "supplier", label: "Supplier" },
      { key: "posting_date", label: "Posting Date" },
      { key: "purchase_order", label: "Purchase Order" },
      { key: "total", label: "Received Value" },
      { key: "purchase_invoice", label: "Purchase Invoice" },
      { key: "billed", label: "Billed" },
    ],
    // Submitted purchase receipts and whether each has been billed.
    sql: `SELECT "name" AS "purchase_receipt", "supplier", "posting_date", "purchase_order",
                 coalesce("total", 0)::float8 AS "total", "purchase_invoice",
                 CASE WHEN "purchase_invoice" IS NOT NULL THEN 'Yes' ELSE 'No' END AS "billed"
          FROM "tabPurchase Receipt"
          WHERE "docstatus" = 1
          ORDER BY "posting_date" DESC, "name"`,
  },
  "delivery-billing-status": {
    permDoctype: "Delivery Note",
    columns: [
      { key: "delivery_note", label: "Delivery Note" },
      { key: "customer", label: "Customer" },
      { key: "posting_date", label: "Posting Date" },
      { key: "sales_order", label: "Sales Order" },
      { key: "total", label: "Delivered Value" },
      { key: "sales_invoice", label: "Sales Invoice" },
      { key: "billed", label: "Billed" },
    ],
    // Submitted (non-return) delivery notes and whether each has been billed.
    sql: `SELECT "name" AS "delivery_note", "customer", "posting_date", "sales_order",
                 coalesce("total", 0)::float8 AS "total", "sales_invoice",
                 CASE WHEN "sales_invoice" IS NOT NULL THEN 'Yes' ELSE 'No' END AS "billed"
          FROM "tabDelivery Note"
          WHERE "docstatus" = 1 AND coalesce("is_return", 0) = 0
          ORDER BY "posting_date" DESC, "name"`,
  },
  "pick-list-status": {
    permDoctype: "Pick List",
    columns: [
      { key: "pick_list", label: "Pick List" },
      { key: "customer", label: "Customer" },
      { key: "sales_order", label: "Sales Order" },
      { key: "posting_date", label: "Posting Date" },
      { key: "total_qty", label: "Total Qty" },
      { key: "status", label: "Status" },
      { key: "delivery_note", label: "Delivery Note" },
    ],
    // Pick lists with their total picked quantity and their source order / delivery links.
    sql: `SELECT p."name" AS "pick_list", p."customer", p."sales_order", p."posting_date",
                 coalesce(sum(l."qty"), 0)::float8 AS "total_qty",
                 coalesce(p."status", 'Draft') AS "status", p."delivery_note"
          FROM "tabPick List" p
          LEFT JOIN "tabPick List Item" l ON l."parent" = p."name"
          GROUP BY p."name", p."customer", p."sales_order", p."posting_date", p."status", p."delivery_note"
          ORDER BY p."posting_date" DESC, p."name"`,
  },
  "blanket-order-status": {
    permDoctype: "Blanket Order",
    columns: [
      { key: "blanket_order", label: "Blanket Order" },
      { key: "customer", label: "Customer" },
      { key: "item_code", label: "Item" },
      { key: "total_qty", label: "Total Qty" },
      { key: "ordered_qty", label: "Ordered Qty" },
      { key: "remaining_qty", label: "Remaining Qty" },
      { key: "status", label: "Status" },
    ],
    // Submitted blanket orders with their draw-down progress (remaining = total − ordered).
    sql: `SELECT "name" AS "blanket_order", "customer", "item_code",
                 coalesce("total_qty", 0)::float8 AS "total_qty",
                 coalesce("ordered_qty", 0)::float8 AS "ordered_qty",
                 (coalesce("total_qty", 0) - coalesce("ordered_qty", 0))::float8 AS "remaining_qty",
                 coalesce("status", 'Active') AS "status"
          FROM "tabBlanket Order"
          WHERE "docstatus" = 1
          ORDER BY "name"`,
  },
  "opportunity-funnel": {
    permDoctype: "Opportunity",
    columns: [
      { key: "opportunity", label: "Opportunity" },
      { key: "customer", label: "Customer" },
      { key: "status", label: "Status" },
      { key: "sales_stage", label: "Sales Stage" },
      { key: "opportunity_amount", label: "Amount" },
      { key: "weighted_amount", label: "Weighted" },
      { key: "lead", label: "Source Lead" },
      { key: "quotation", label: "Quotation" },
    ],
    // Each opportunity with its funnel position and linked source lead / quotation.
    sql: `SELECT "name" AS "opportunity", "customer",
                 coalesce("status", 'Open') AS "status",
                 coalesce("sales_stage", 'Prospecting') AS "sales_stage",
                 coalesce("opportunity_amount", 0)::float8 AS "opportunity_amount",
                 coalesce("weighted_amount", 0)::float8 AS "weighted_amount",
                 "lead", "quotation"
          FROM "tabOpportunity"
          ORDER BY "name"`,
  },
  "quotation-status": {
    permDoctype: "Quotation",
    columns: [
      { key: "quotation", label: "Quotation" },
      { key: "customer", label: "Customer" },
      { key: "transaction_date", label: "Date" },
      { key: "valid_till", label: "Valid Till" },
      { key: "grand_total", label: "Grand Total" },
      { key: "status", label: "Status" },
      { key: "sales_order", label: "Sales Order" },
    ],
    // Submitted quotations with their order-conversion status and linked Sales Order.
    sql: `SELECT "name" AS "quotation", "customer", "transaction_date", "valid_till",
                 coalesce("grand_total", "total", 0)::float8 AS "grand_total",
                 coalesce("status", 'Open') AS "status", "sales_order"
          FROM "tabQuotation"
          WHERE "docstatus" = 1
          ORDER BY "transaction_date" DESC, "name"`,
  },
  "sales-order-status": {
    permDoctype: "Sales Order",
    columns: [
      { key: "sales_order", label: "Sales Order" },
      { key: "customer", label: "Customer" },
      { key: "grand_total", label: "Order Value" },
      { key: "per_delivered", label: "% Delivered" },
      { key: "per_billed", label: "% Billed" },
      { key: "status", label: "Status" },
    ],
    // Fulfilment position per submitted Sales Order (delivered / billed progress).
    sql: `SELECT "name" AS "sales_order", "customer",
                 coalesce("grand_total", "total", 0)::float8 AS "grand_total",
                 coalesce("per_delivered", 0)::float8 AS "per_delivered",
                 coalesce("per_billed", 0)::float8 AS "per_billed", "status"
          FROM "tabSales Order"
          WHERE "docstatus" = 1
          ORDER BY "name"`,
  },
  "purchase-order-status": {
    permDoctype: "Purchase Order",
    columns: [
      { key: "purchase_order", label: "Purchase Order" },
      { key: "supplier", label: "Supplier" },
      { key: "grand_total", label: "Order Value" },
      { key: "per_received", label: "% Received" },
      { key: "per_billed", label: "% Billed" },
      { key: "status", label: "Status" },
    ],
    // Fulfilment position per submitted Purchase Order (received / billed progress).
    sql: `SELECT "name" AS "purchase_order", "supplier",
                 coalesce("grand_total", "total", 0)::float8 AS "grand_total",
                 coalesce("per_received", 0)::float8 AS "per_received",
                 coalesce("per_billed", 0)::float8 AS "per_billed", "status"
          FROM "tabPurchase Order"
          WHERE "docstatus" = 1
          ORDER BY "name"`,
  },
  "top-purchased-items": {
    permDoctype: "Purchase Invoice",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "qty", label: "Qty Purchased" },
      { key: "spend", label: "Spend" },
    ],
    // Quantity and spend per item across submitted (non-return) Purchase Invoices.
    sql: `SELECT pi_item."item_code",
                 sum(pi_item."qty")::float8 AS "qty",
                 sum(coalesce(pi_item."amount", 0))::float8 AS "spend"
          FROM "tabPurchase Invoice Item" pi_item
          JOIN "tabPurchase Invoice" pi ON pi."name" = pi_item."parent"
          WHERE pi."docstatus" = 1 AND coalesce(pi."is_return", 0) = 0
          GROUP BY pi_item."item_code"
          ORDER BY "spend" DESC`,
  },
  "supplier-spend": {
    permDoctype: "Purchase Invoice",
    columns: [
      { key: "supplier", label: "Supplier" },
      { key: "invoices", label: "Invoices" },
      { key: "spend", label: "Spend" },
      { key: "outstanding", label: "Outstanding" },
    ],
    // Per supplier: invoice count, total billed, and total outstanding.
    sql: `SELECT "supplier",
                 count(*)::int AS "invoices",
                 sum(coalesce("grand_total", "total", 0))::float8 AS "spend",
                 sum(coalesce("outstanding_amount", 0))::float8 AS "outstanding"
          FROM "tabPurchase Invoice"
          WHERE "docstatus" = 1 AND coalesce("is_return", 0) = 0
          GROUP BY "supplier"
          ORDER BY "spend" DESC`,
  },
  "purchase-price-trend": {
    permDoctype: "Purchase Invoice",
    columns: [
      { key: "item_code", label: "Item" },
      { key: "qty", label: "Qty" },
      { key: "avg_rate", label: "Avg Rate" },
      { key: "min_rate", label: "Min Rate" },
      { key: "max_rate", label: "Max Rate" },
    ],
    // Purchase-rate spread per item across submitted Purchase Invoice lines.
    sql: `SELECT pi_item."item_code",
                 sum(pi_item."qty")::float8 AS "qty",
                 round(avg(pi_item."rate")::numeric, 2)::float8 AS "avg_rate",
                 min(pi_item."rate")::float8 AS "min_rate",
                 max(pi_item."rate")::float8 AS "max_rate"
          FROM "tabPurchase Invoice Item" pi_item
          JOIN "tabPurchase Invoice" pi ON pi."name" = pi_item."parent"
          WHERE pi."docstatus" = 1 AND coalesce(pi."is_return", 0) = 0 AND pi_item."rate" > 0
          GROUP BY pi_item."item_code"
          ORDER BY "item_code"`,
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
