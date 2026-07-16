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
  "timesheet-billing-status": {
    permDoctype: "Timesheet",
    columns: [
      { key: "timesheet", label: "Timesheet" },
      { key: "employee", label: "Employee" },
      { key: "project", label: "Project" },
      { key: "hours", label: "Hours" },
      { key: "billable_amount", label: "Billable Amount" },
      { key: "sales_invoice", label: "Sales Invoice" },
      { key: "billed", label: "Billed" },
    ],
    // Submitted billable timesheets and whether each has been invoiced.
    sql: `SELECT "name" AS "timesheet", "employee", "project",
                 coalesce("hours", 0)::float8 AS "hours",
                 coalesce("billable_amount", 0)::float8 AS "billable_amount",
                 "sales_invoice",
                 CASE WHEN "sales_invoice" IS NOT NULL THEN 'Yes' ELSE 'No' END AS "billed"
          FROM "tabTimesheet"
          WHERE "docstatus" = 1 AND coalesce("is_billable", 0) = 1
          ORDER BY "posting_date" DESC, "name"`,
  },
  "journal-entry-register": {
    permDoctype: "Journal Entry",
    columns: [
      { key: "journal_entry", label: "Journal Entry" },
      { key: "posting_date", label: "Posting Date" },
      { key: "user_remark", label: "Remark" },
      { key: "total_debit", label: "Total Debit" },
      { key: "reversal_of", label: "Reversal Of" },
    ],
    // Submitted journal entries with their totals and any entry they reverse.
    sql: `SELECT "name" AS "journal_entry", "posting_date", "user_remark",
                 coalesce("total_debit", 0)::float8 AS "total_debit", "reversal_of"
          FROM "tabJournal Entry"
          WHERE "docstatus" = 1
          ORDER BY "posting_date" DESC, "name"`,
  },
  "maintenance-schedule-status": {
    permDoctype: "Maintenance Schedule",
    columns: [
      { key: "maintenance_schedule", label: "Schedule" },
      { key: "customer", label: "Customer" },
      { key: "item_code", label: "Item" },
      { key: "total_visits", label: "Total Visits" },
      { key: "completed_visits", label: "Completed" },
      { key: "pending_visits", label: "Pending" },
      { key: "status", label: "Status" },
    ],
    // Submitted maintenance schedules with their planned vs completed visit counts.
    sql: `SELECT m."name" AS "maintenance_schedule", m."customer", m."item_code",
                 count(d."name")::int AS "total_visits",
                 count(*) FILTER (WHERE d."status" = 'Completed')::int AS "completed_visits",
                 count(*) FILTER (WHERE d."status" = 'Pending')::int AS "pending_visits",
                 coalesce(m."status", 'Draft') AS "status"
          FROM "tabMaintenance Schedule" m
          LEFT JOIN "tabMaintenance Schedule Detail" d ON d."parent" = m."name"
          WHERE m."docstatus" = 1
          GROUP BY m."name", m."customer", m."item_code", m."status"
          ORDER BY m."name"`,
  },
  "contract-status": {
    permDoctype: "Contract",
    columns: [
      { key: "contract", label: "Contract" },
      { key: "party", label: "Party" },
      { key: "start_date", label: "Start" },
      { key: "end_date", label: "End" },
      { key: "contract_value", label: "Value" },
      { key: "days_remaining", label: "Days Remaining" },
      { key: "status", label: "Status" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT "name" AS "contract", "party", "start_date", "end_date",
                      coalesce("contract_value", 0)::float8 AS "contract_value",
                      CASE WHEN "end_date" IS NULL THEN NULL
                           ELSE ("end_date"::date - $1::date) END AS "days_remaining",
                      coalesce("status", 'Draft') AS "status"
               FROM "tabContract"
               WHERE "docstatus" = 1
               ORDER BY "end_date", "name"`,
        params: [asOf],
      };
    },
  },
  "quality-inspection-status": {
    permDoctype: "Quality Inspection",
    columns: [
      { key: "quality_inspection", label: "Inspection" },
      { key: "inspection_type", label: "Type" },
      { key: "reference_type", label: "Reference Type" },
      { key: "reference_name", label: "Reference" },
      { key: "item_code", label: "Item" },
      { key: "status", label: "Status" },
    ],
    // Submitted quality inspections with their referenced document and accept/reject status.
    sql: `SELECT "name" AS "quality_inspection", "inspection_type", "reference_type",
                 "reference_name", "item_code", coalesce("status", 'Accepted') AS "status"
          FROM "tabQuality Inspection"
          WHERE "docstatus" = 1
          ORDER BY "name"`,
  },
  "bank-reconciliation-status": {
    permDoctype: "Bank Transaction",
    columns: [
      { key: "transaction", label: "Transaction" },
      { key: "date", label: "Date" },
      { key: "bank_account", label: "Bank Account" },
      { key: "deposit", label: "Deposit" },
      { key: "withdrawal", label: "Withdrawal" },
      { key: "status", label: "Status" },
      { key: "payment_entry", label: "Payment Entry" },
    ],
    // Bank transactions with their reconciliation status and matched payment entry.
    sql: `SELECT "name" AS "transaction", "date", "bank_account",
                 coalesce("deposit", 0)::float8 AS "deposit",
                 coalesce("withdrawal", 0)::float8 AS "withdrawal",
                 coalesce("status", 'Unreconciled') AS "status", "payment_entry"
          FROM "tabBank Transaction"
          ORDER BY "date" DESC, "name"`,
  },
  "batch-expiry-status": {
    permDoctype: "Batch",
    columns: [
      { key: "batch", label: "Batch" },
      { key: "item", label: "Item" },
      { key: "manufacturing_date", label: "Manufactured" },
      { key: "expiry_date", label: "Expiry" },
      { key: "days_to_expiry", label: "Days to Expiry" },
      { key: "expired", label: "Expired" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT "name" AS "batch", "item", "manufacturing_date", "expiry_date",
                      CASE WHEN "expiry_date" IS NULL THEN NULL
                           ELSE ("expiry_date"::date - $1::date) END AS "days_to_expiry",
                      CASE WHEN "expiry_date" IS NOT NULL AND "expiry_date"::date <= $1::date
                           THEN 'Yes' ELSE 'No' END AS "expired"
               FROM "tabBatch"
               ORDER BY "expiry_date" NULLS LAST, "name"`,
        params: [asOf],
      };
    },
  },
  "batch-wise-stock-balance": {
    permDoctype: "Bin",
    columns: [
      { key: "item", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "batch", label: "Batch" },
      { key: "actual_qty", label: "On Hand" },
      { key: "expiry_date", label: "Expiry" },
      { key: "days_to_expiry", label: "Days to Expiry" },
      { key: "expired", label: "Expired" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT b."item_code" AS "item", b."warehouse", b."batch_no" AS "batch",
                      b."actual_qty", bt."expiry_date",
                      CASE WHEN bt."expiry_date" IS NULL THEN NULL
                           ELSE (bt."expiry_date"::date - $1::date) END AS "days_to_expiry",
                      CASE WHEN bt."expiry_date" IS NOT NULL AND bt."expiry_date"::date <= $1::date
                           THEN 'Yes' ELSE 'No' END AS "expired"
               FROM "tabBin" b
               JOIN "tabBatch" bt ON bt."name" = b."batch_no"
               WHERE coalesce(b."batch_no", '') <> '' AND b."actual_qty" <> 0
               ORDER BY b."item_code", b."warehouse", bt."expiry_date" NULLS LAST, b."batch_no"`,
        params: [asOf],
      };
    },
  },
  "timesheet-approval-status": {
    permDoctype: "Timesheet",
    columns: [
      { key: "timesheet", label: "Timesheet" },
      { key: "employee", label: "Employee" },
      { key: "project", label: "Project" },
      { key: "hours", label: "Hours" },
      { key: "billable_amount", label: "Billable" },
      { key: "approval_status", label: "Approval" },
      { key: "sales_invoice", label: "Billed Via" },
    ],
    sql: `SELECT "name" AS "timesheet", "employee", "project", "hours",
                 coalesce("billable_amount", 0) AS "billable_amount",
                 coalesce("approval_status", 'Draft') AS "approval_status",
                 "sales_invoice"
          FROM "tabTimesheet"
          WHERE "docstatus" = 1
          ORDER BY "posting_date" DESC NULLS LAST, "name"`,
  },
  "quotation-expiry-status": {
    permDoctype: "Quotation",
    columns: [
      { key: "quotation", label: "Quotation" },
      { key: "customer", label: "Customer" },
      { key: "grand_total", label: "Amount" },
      { key: "valid_till", label: "Valid Till" },
      { key: "days_to_expiry", label: "Days to Expiry" },
      { key: "status", label: "Status" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT "name" AS "quotation", "customer", "grand_total", "valid_till",
                      CASE WHEN "valid_till" IS NULL THEN NULL
                           ELSE ("valid_till"::date - $1::date) END AS "days_to_expiry",
                      "status"
               FROM "tabQuotation"
               WHERE "docstatus" = 1
               ORDER BY "valid_till" NULLS LAST, "name"`,
        params: [asOf],
      };
    },
  },
  "installation-status": {
    permDoctype: "Delivery Note",
    columns: [
      { key: "delivery_note", label: "Delivery Note" },
      { key: "customer", label: "Customer" },
      { key: "item_code", label: "Item" },
      { key: "delivered", label: "Delivered" },
      { key: "installed", label: "Installed" },
      { key: "pending", label: "Pending" },
    ],
    // Per Delivery Note + item: delivered qty vs installed qty (submitted
    // Installation Notes) and the outstanding balance still to install.
    sql: `SELECT dn."name" AS "delivery_note", dn."customer",
                 di."item_code",
                 coalesce(sum(di."qty"), 0)::float8 AS "delivered",
                 coalesce(ins."installed", 0)::float8 AS "installed",
                 (coalesce(sum(di."qty"), 0) - coalesce(ins."installed", 0))::float8 AS "pending"
          FROM "tabDelivery Note" dn
          JOIN "tabDelivery Note Item" di ON di."parent" = dn."name"
          LEFT JOIN (
            SELECT ino."delivery_note" AS dnn, ii."item_code" AS ic, sum(ii."qty") AS "installed"
            FROM "tabInstallation Note" ino
            JOIN "tabInstallation Note Item" ii ON ii."parent" = ino."name"
            WHERE ino."docstatus" = 1
            GROUP BY ino."delivery_note", ii."item_code"
          ) ins ON ins.dnn = dn."name" AND ins.ic = di."item_code"
          WHERE dn."docstatus" = 1 AND coalesce(dn."is_return", 0) = 0
          GROUP BY dn."name", dn."customer", di."item_code", ins."installed"
          ORDER BY dn."name", di."item_code"`,
  },
  "project-task-status": {
    permDoctype: "Project",
    columns: [
      { key: "project", label: "Project" },
      { key: "total_tasks", label: "Tasks" },
      { key: "completed_tasks", label: "Completed" },
      { key: "open_tasks", label: "Open" },
      { key: "percent_complete", label: "% Complete" },
      { key: "status", label: "Status" },
    ],
    // Per project: task counts by completion and the rolled-up percent complete.
    sql: `SELECT p."name" AS "project",
                 count(t."name") AS "total_tasks",
                 coalesce(sum(CASE WHEN t."status" = 'Completed' THEN 1 ELSE 0 END), 0) AS "completed_tasks",
                 coalesce(sum(CASE WHEN coalesce(t."status", 'Open') NOT IN ('Completed', 'Cancelled') THEN 1 ELSE 0 END), 0) AS "open_tasks",
                 coalesce(p."percent_complete", 0)::float8 AS "percent_complete",
                 coalesce(p."status", 'Open') AS "status"
          FROM "tabProject" p
          LEFT JOIN "tabTask" t ON t."project" = p."name"
          GROUP BY p."name", p."percent_complete", p."status"
          ORDER BY p."name"`,
  },
  "warranty-claim-status": {
    permDoctype: "Warranty Claim",
    columns: [
      { key: "warranty_claim", label: "Warranty Claim" },
      { key: "customer", label: "Customer" },
      { key: "item_code", label: "Item" },
      { key: "warranty_status", label: "Warranty" },
      { key: "complaint_date", label: "Complaint Date" },
      { key: "resolution_date", label: "Resolution Date" },
      { key: "days_open", label: "Days Open" },
      { key: "status", label: "Status" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    // Warranty claims with warranty status, resolution date, and days open
    // (to resolution, or to the as-of date while still open).
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT "name" AS "warranty_claim", "customer", "item_code", "warranty_status",
                      "complaint_date", "resolution_date",
                      CASE WHEN "complaint_date" IS NULL THEN NULL
                           ELSE (coalesce("resolution_date"::date, $1::date) - "complaint_date"::date) END AS "days_open",
                      coalesce("status", 'Open') AS "status"
               FROM "tabWarranty Claim"
               ORDER BY coalesce("status", 'Open'), "complaint_date" DESC, "name"`,
        params: [asOf],
      };
    },
  },
  "material-request-fulfillment": {
    permDoctype: "Material Request",
    columns: [
      { key: "material_request", label: "Material Request" },
      { key: "item_code", label: "Item" },
      { key: "requested_qty", label: "Requested" },
      { key: "ordered_qty", label: "Ordered" },
      { key: "pending_qty", label: "Pending" },
      { key: "status", label: "Status" },
    ],
    // Per Material Request item: requested vs ordered qty, the outstanding
    // balance, and the request's overall status.
    sql: `SELECT mr."name" AS "material_request", mri."item_code",
                 coalesce(mri."qty", 0)::float8 AS "requested_qty",
                 coalesce(mri."ordered_qty", 0)::float8 AS "ordered_qty",
                 (coalesce(mri."qty", 0) - coalesce(mri."ordered_qty", 0))::float8 AS "pending_qty",
                 mr."status"
          FROM "tabMaterial Request" mr
          JOIN "tabMaterial Request Item" mri ON mri."parent" = mr."name"
          WHERE mr."docstatus" = 1
          ORDER BY mr."name", mri."item_code"`,
  },
  "job-card-status": {
    permDoctype: "Job Card",
    columns: [
      { key: "job_card", label: "Job Card" },
      { key: "work_order", label: "Work Order" },
      { key: "operation", label: "Operation" },
      { key: "workstation", label: "Workstation" },
      { key: "planned_time", label: "Planned (min)" },
      { key: "actual_time", label: "Actual (min)" },
      { key: "status", label: "Status" },
    ],
    // Every Job Card with its operation, planned vs actual minutes, and status.
    sql: `SELECT "name" AS "job_card", "work_order", "operation", "workstation",
                 coalesce("time_in_mins", 0)::float8 AS "planned_time",
                 coalesce("actual_time_in_mins", 0)::float8 AS "actual_time",
                 "status"
          FROM "tabJob Card"
          ORDER BY "work_order", "name"`,
  },
  "subcontracting-status": {
    permDoctype: "Subcontracting Order",
    columns: [
      { key: "subcontracting_order", label: "Subcontracting Order" },
      { key: "supplier", label: "Subcontractor" },
      { key: "finished_item", label: "Finished Item" },
      { key: "ordered_qty", label: "Ordered" },
      { key: "received_qty", label: "Received" },
      { key: "pending_qty", label: "Pending" },
      { key: "status", label: "Status" },
    ],
    // Subcontracting orders with the finished-good qty received to date and the
    // outstanding balance still to receive.
    sql: `SELECT sco."name" AS "subcontracting_order", sco."supplier", sco."finished_item",
                 coalesce(sco."qty", 0)::float8 AS "ordered_qty",
                 coalesce(r."qty", 0)::float8 AS "received_qty",
                 (coalesce(sco."qty", 0) - coalesce(r."qty", 0))::float8 AS "pending_qty",
                 sco."status"
          FROM "tabSubcontracting Order" sco
          LEFT JOIN (
            SELECT "subcontracting_order" AS sco, sum("qty") AS "qty"
            FROM "tabSubcontracting Receipt"
            WHERE "docstatus" = 1
            GROUP BY "subcontracting_order"
          ) r ON r.sco = sco."name"
          WHERE sco."docstatus" = 1
          ORDER BY sco."name"`,
  },
  "purchase-order-shortfall": {
    permDoctype: "Purchase Order",
    columns: [
      { key: "purchase_order", label: "Purchase Order" },
      { key: "supplier", label: "Supplier" },
      { key: "ordered_qty", label: "Ordered" },
      { key: "received_qty", label: "Received" },
      { key: "shortfall_qty", label: "Shortfall" },
    ],
    sql: `SELECT po."name" AS "purchase_order", po."supplier",
                 coalesce(o."qty", 0) AS "ordered_qty",
                 coalesce(r."qty", 0) AS "received_qty",
                 (coalesce(o."qty", 0) - coalesce(r."qty", 0)) AS "shortfall_qty"
          FROM "tabPurchase Order" po
          LEFT JOIN (
            SELECT "parent", sum("qty") AS "qty" FROM "tabPurchase Order Item" GROUP BY "parent"
          ) o ON o."parent" = po."name"
          LEFT JOIN (
            SELECT pri."purchase_order" AS po, sum(prii."qty") AS "qty"
            FROM "tabPurchase Receipt Item" prii
            JOIN "tabPurchase Receipt" pri ON pri."name" = prii."parent" AND pri."docstatus" = 1
            GROUP BY pri."purchase_order"
          ) r ON r.po = po."name"
          WHERE po."docstatus" = 1 AND coalesce(po."is_closed", 0) = 1
          ORDER BY po."name"`,
  },
  "purchase-orders-on-hold": {
    permDoctype: "Purchase Order",
    columns: [
      { key: "purchase_order", label: "Purchase Order" },
      { key: "supplier", label: "Supplier" },
      { key: "grand_total", label: "Amount" },
      { key: "hold_reason", label: "Hold Reason" },
    ],
    sql: `SELECT "name" AS "purchase_order", "supplier", "grand_total", "hold_reason"
          FROM "tabPurchase Order"
          WHERE "docstatus" = 1 AND coalesce("on_hold", 0) = 1
          ORDER BY "name"`,
  },
  "sales-orders-on-hold": {
    permDoctype: "Sales Order",
    columns: [
      { key: "sales_order", label: "Sales Order" },
      { key: "customer", label: "Customer" },
      { key: "grand_total", label: "Amount" },
      { key: "hold_reason", label: "Hold Reason" },
    ],
    sql: `SELECT "name" AS "sales_order", "customer", "grand_total", "hold_reason"
          FROM "tabSales Order"
          WHERE "docstatus" = 1 AND coalesce("on_hold", 0) = 1
          ORDER BY "name"`,
  },
  "sales-order-shortfall": {
    permDoctype: "Sales Order",
    columns: [
      { key: "sales_order", label: "Sales Order" },
      { key: "customer", label: "Customer" },
      { key: "ordered_qty", label: "Ordered" },
      { key: "delivered_qty", label: "Delivered" },
      { key: "shortfall_qty", label: "Shortfall" },
    ],
    // Short-closed orders with the un-delivered balance written off at close.
    sql: `SELECT so."name" AS "sales_order", so."customer",
                 coalesce(o."qty", 0) AS "ordered_qty",
                 coalesce(d."qty", 0) AS "delivered_qty",
                 (coalesce(o."qty", 0) - coalesce(d."qty", 0)) AS "shortfall_qty"
          FROM "tabSales Order" so
          LEFT JOIN (
            SELECT "parent", sum("qty") AS "qty" FROM "tabSales Order Item" GROUP BY "parent"
          ) o ON o."parent" = so."name"
          LEFT JOIN (
            SELECT dni."sales_order" AS so, sum(dnii."qty") AS "qty"
            FROM "tabDelivery Note Item" dnii
            JOIN "tabDelivery Note" dni ON dni."name" = dnii."parent"
            WHERE dni."docstatus" = 1 AND coalesce(dni."is_return", 0) = 0
            GROUP BY dni."sales_order"
          ) d ON d.so = so."name"
          WHERE so."docstatus" = 1 AND coalesce(so."is_closed", 0) = 1
          ORDER BY so."name"`,
  },
  "loan-foreclosure-register": {
    permDoctype: "Loan",
    columns: [
      { key: "loan", label: "Loan" },
      { key: "employee", label: "Employee" },
      { key: "settlement_date", label: "Settlement Date" },
      { key: "settled_amount", label: "Settled Amount" },
    ],
    sql: `SELECT "voucher_no" AS "loan", max("against") AS "employee",
                 max("posting_date") AS "settlement_date",
                 coalesce(sum("debit"), 0) AS "settled_amount"
          FROM "tabGL Entry"
          WHERE "voucher_type" = 'Loan Foreclosure'
          GROUP BY "voucher_no"
          ORDER BY max("posting_date") DESC, "voucher_no"`,
  },
  "non-conformance-status": {
    permDoctype: "Non Conformance",
    columns: [
      { key: "ncr", label: "NCR" },
      { key: "subject", label: "Subject" },
      { key: "severity", label: "Severity" },
      { key: "reference_name", label: "Reference" },
      { key: "reported_on", label: "Reported On" },
      { key: "status", label: "Status" },
    ],
    sql: `SELECT "name" AS "ncr", "subject", "severity", "reference_name", "reported_on",
                 CASE "docstatus" WHEN 1 THEN 'Closed' WHEN 2 THEN 'Cancelled' ELSE 'Open' END AS "status"
          FROM "tabNon Conformance"
          ORDER BY CASE "severity" WHEN 'Critical' THEN 0 WHEN 'Major' THEN 1 ELSE 2 END, "name" DESC`,
  },
  "onboarding-status": {
    permDoctype: "Employee Onboarding",
    columns: [
      { key: "onboarding", label: "Onboarding" },
      { key: "employee", label: "Employee" },
      { key: "total_activities", label: "Total" },
      { key: "completed_activities", label: "Completed" },
      { key: "percent_complete", label: "% Complete" },
      { key: "status", label: "Status" },
    ],
    sql: `SELECT "name" AS "onboarding", "employee",
                 coalesce("total_activities", 0) AS "total_activities",
                 coalesce("completed_activities", 0) AS "completed_activities",
                 coalesce("percent_complete", 0) AS "percent_complete",
                 CASE "docstatus" WHEN 1 THEN 'Completed' WHEN 2 THEN 'Cancelled' ELSE 'In Progress' END AS "status"
          FROM "tabEmployee Onboarding"
          ORDER BY "name" DESC`,
  },
  "sales-target-achievement": {
    permDoctype: "Sales Target",
    columns: [
      { key: "target", label: "Target" },
      { key: "sales_person", label: "Sales Person" },
      { key: "from_date", label: "From" },
      { key: "to_date", label: "To" },
      { key: "target_amount", label: "Target Amount" },
      { key: "achieved_amount", label: "Achieved" },
      { key: "percent", label: "Achievement %" },
      { key: "status", label: "Status" },
    ],
    sql: `SELECT "name" AS "target", "sales_person", "from_date", "to_date",
                 "target_amount", coalesce("achieved_amount", 0) AS "achieved_amount",
                 CASE WHEN "target_amount" > 0
                      THEN round(coalesce("achieved_amount", 0) / "target_amount" * 100, 2)
                      ELSE 0 END AS "percent",
                 CASE WHEN coalesce("achieved_amount", 0) >= "target_amount" THEN 'Met' ELSE 'In Progress' END AS "status"
          FROM "tabSales Target"
          WHERE "docstatus" = 1
          ORDER BY "from_date" DESC, "sales_person"`,
  },
  "sla-breach-status": {
    permDoctype: "Issue",
    columns: [
      { key: "issue", label: "Issue" },
      { key: "subject", label: "Subject" },
      { key: "priority", label: "Priority" },
      { key: "status", label: "Status" },
      { key: "resolution_by", label: "Resolution By" },
      { key: "escalated", label: "Escalated" },
      { key: "agreement_status", label: "SLA" },
    ],
    sql: `SELECT "name" AS "issue", "subject", "priority", "status", "resolution_by",
                 CASE WHEN coalesce("escalated", 0) = 1 THEN 'Yes' ELSE 'No' END AS "escalated",
                 "agreement_status"
          FROM "tabIssue"
          WHERE "agreement_status" = 'Failed' OR coalesce("escalated", 0) = 1
          ORDER BY "escalation_date" DESC NULLS LAST, "name"`,
  },
  "opportunity-loss-analysis": {
    permDoctype: "Opportunity",
    columns: [
      { key: "lost_reason", label: "Lost Reason" },
      { key: "opportunities", label: "Opportunities" },
      { key: "lost_amount", label: "Lost Amount" },
    ],
    sql: `SELECT coalesce(nullif(trim("lost_reason"), ''), '(unspecified)') AS "lost_reason",
                 count(*) AS "opportunities",
                 coalesce(sum("opportunity_amount"), 0) AS "lost_amount"
          FROM "tabOpportunity"
          WHERE "status" = 'Lost'
          GROUP BY coalesce(nullif(trim("lost_reason"), ''), '(unspecified)')
          ORDER BY "lost_amount" DESC`,
  },
  "final-settlement-register": {
    permDoctype: "Full and Final Statement",
    columns: [
      { key: "settlement", label: "Statement" },
      { key: "employee", label: "Employee" },
      { key: "relieving_date", label: "Relieving Date" },
      { key: "leave_encashment", label: "Leave Encashment" },
      { key: "net_payable", label: "Net Payable" },
      { key: "status", label: "Status" },
    ],
    sql: `SELECT "name" AS "settlement", "employee", "relieving_date",
                 "leave_encashment", "net_payable",
                 CASE "docstatus" WHEN 1 THEN 'Submitted' WHEN 2 THEN 'Cancelled' ELSE 'Draft' END AS "status"
          FROM "tabFull and Final Statement"
          ORDER BY "relieving_date" DESC, "name"`,
  },
  "cost-center-balance": {
    permDoctype: "GL Entry",
    columns: [
      { key: "cost_center", label: "Cost Center" },
      { key: "debit", label: "Debit" },
      { key: "credit", label: "Credit" },
      { key: "balance", label: "Balance" },
    ],
    sql: `SELECT "cost_center",
                 coalesce(sum("debit"), 0) AS "debit",
                 coalesce(sum("credit"), 0) AS "credit",
                 coalesce(sum("debit"), 0) - coalesce(sum("credit"), 0) AS "balance"
          FROM "tabGL Entry"
          WHERE coalesce("cost_center", '') <> ''
          GROUP BY "cost_center"
          ORDER BY "cost_center"`,
  },
  "shipment-status": {
    permDoctype: "Shipment",
    columns: [
      { key: "shipment", label: "Shipment" },
      { key: "carrier", label: "Carrier" },
      { key: "awb_number", label: "AWB / Tracking" },
      { key: "notes", label: "Delivery Notes" },
      { key: "total_weight", label: "Total Weight" },
      { key: "status", label: "Status" },
    ],
    sql: `SELECT sh."name" AS "shipment", sh."carrier", sh."awb_number",
                 count(sdn."name") AS "notes", sh."total_weight",
                 CASE sh."docstatus" WHEN 1 THEN 'Submitted' WHEN 2 THEN 'Cancelled' ELSE 'Draft' END AS "status"
          FROM "tabShipment" sh
          LEFT JOIN "tabShipment Delivery Note" sdn ON sdn."parent" = sh."name"
          GROUP BY sh."name", sh."carrier", sh."awb_number", sh."total_weight", sh."docstatus"
          ORDER BY sh."name"`,
  },
  "delivery-trip-status": {
    permDoctype: "Delivery Trip",
    columns: [
      { key: "delivery_trip", label: "Delivery Trip" },
      { key: "driver", label: "Driver" },
      { key: "vehicle", label: "Vehicle" },
      { key: "stops", label: "Stops" },
      { key: "delivered", label: "Delivered" },
      { key: "status", label: "Status" },
    ],
    // Per trip: stop count vs delivered-stop count and the current status.
    sql: `SELECT t."name" AS "delivery_trip", t."driver", t."vehicle",
                 count(s."name") AS "stops",
                 coalesce(sum(CASE WHEN coalesce(s."delivered", 0) = 1 THEN 1 ELSE 0 END), 0) AS "delivered",
                 t."status"
          FROM "tabDelivery Trip" t
          LEFT JOIN "tabDelivery Trip Stop" s ON s."parent" = t."name"
          WHERE t."docstatus" < 2
          GROUP BY t."name", t."driver", t."vehicle", t."status"
          ORDER BY t."name"`,
  },
  "packing-slip-status": {
    permDoctype: "Delivery Note",
    columns: [
      { key: "delivery_note", label: "Delivery Note" },
      { key: "item_code", label: "Item" },
      { key: "delivered", label: "Delivered" },
      { key: "packed", label: "Packed" },
      { key: "remaining", label: "Remaining" },
    ],
    sql: `SELECT d."delivery_note", d."item_code", d."delivered",
                 coalesce(p."packed", 0) AS "packed",
                 (d."delivered" - coalesce(p."packed", 0)) AS "remaining"
          FROM (
            SELECT dni."parent" AS "delivery_note", dni."item_code",
                   sum(dni."qty") AS "delivered"
            FROM "tabDelivery Note Item" dni
            JOIN "tabDelivery Note" dn ON dn."name" = dni."parent" AND dn."docstatus" = 1
            GROUP BY dni."parent", dni."item_code"
          ) d
          LEFT JOIN (
            SELECT ps."delivery_note", psi."item_code", sum(psi."qty") AS "packed"
            FROM "tabPacking Slip Item" psi
            JOIN "tabPacking Slip" ps ON ps."name" = psi."parent" AND ps."docstatus" = 1
            GROUP BY ps."delivery_note", psi."item_code"
          ) p ON p."delivery_note" = d."delivery_note" AND p."item_code" = d."item_code"
          ORDER BY d."delivery_note", d."item_code"`,
  },
  "drop-ship-status": {
    permDoctype: "Sales Order",
    columns: [
      { key: "sales_order", label: "Sales Order" },
      { key: "customer", label: "Customer" },
      { key: "item_code", label: "Item" },
      { key: "ordered", label: "Ordered" },
      { key: "supplier", label: "Supplier" },
      { key: "purchase_order", label: "Purchase Order" },
      { key: "po_status", label: "PO Status" },
    ],
    sql: `SELECT so."name" AS "sales_order", so."customer", soi."item_code",
                 soi."qty" AS "ordered", soi."supplier",
                 po."name" AS "purchase_order",
                 coalesce(po."status", 'Not Ordered') AS "po_status"
          FROM "tabSales Order Item" soi
          JOIN "tabSales Order" so ON so."name" = soi."parent"
          LEFT JOIN "tabPurchase Order Item" poi
            ON poi."against_sales_order" = so."name" AND poi."item_code" = soi."item_code"
          LEFT JOIN "tabPurchase Order" po
            ON po."name" = poi."parent" AND po."is_drop_ship" = 1
          WHERE coalesce(soi."delivered_by_supplier", 0) <> 0
          ORDER BY so."name", soi."item_code"`,
  },
  "product-bundle-availability": {
    permDoctype: "Product Bundle",
    columns: [
      { key: "bundle", label: "Bundle Item" },
      { key: "components", label: "Components" },
      { key: "buildable", label: "Buildable Qty" },
    ],
    sql: `SELECT pb."new_item_code" AS "bundle",
                 count(pbi."name") AS "components",
                 coalesce(min(floor(coalesce(oh."qty", 0) / nullif(pbi."qty", 0))), 0) AS "buildable"
          FROM "tabProduct Bundle" pb
          JOIN "tabProduct Bundle Item" pbi ON pbi."parent" = pb."name"
          LEFT JOIN (
            SELECT "item_code", sum("actual_qty") AS "qty" FROM "tabBin" GROUP BY "item_code"
          ) oh ON oh."item_code" = pbi."item_code"
          GROUP BY pb."new_item_code"
          ORDER BY pb."new_item_code"`,
  },
  "expiring-batches": {
    permDoctype: "Bin",
    columns: [
      { key: "item", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "batch", label: "Batch" },
      { key: "actual_qty", label: "On Hand" },
      { key: "expiry_date", label: "Expiry" },
      { key: "days_to_expiry", label: "Days to Expiry" },
    ],
    filters: [
      { fieldname: "as_of", label: "As Of", fieldtype: "Date" },
      { fieldname: "within_days", label: "Within Days", fieldtype: "Int" },
    ],
    build: (f) => {
      const asOf = f.as_of || today();
      const within = Number(f.within_days ?? 30) || 30;
      return {
        text: `SELECT b."item_code" AS "item", b."warehouse", b."batch_no" AS "batch",
                      b."actual_qty", bt."expiry_date",
                      (bt."expiry_date"::date - $1::date) AS "days_to_expiry"
               FROM "tabBin" b
               JOIN "tabBatch" bt ON bt."name" = b."batch_no"
               WHERE coalesce(b."batch_no", '') <> '' AND b."actual_qty" > 0
                 AND bt."expiry_date" IS NOT NULL
                 AND bt."expiry_date"::date <= ($1::date + $2::int)
               ORDER BY bt."expiry_date" ASC, b."item_code", b."warehouse"`,
        params: [asOf, within],
      };
    },
  },
  "serial-no-status": {
    permDoctype: "Serial No",
    columns: [
      { key: "serial_no", label: "Serial No" },
      { key: "item", label: "Item" },
      { key: "warehouse", label: "Warehouse" },
      { key: "status", label: "Status" },
      { key: "voucher_no", label: "Voucher" },
    ],
    // Every tracked serial with its current location and Active/Delivered status.
    sql: `SELECT "serial_no", "item", "warehouse",
                 coalesce("status", 'Active') AS "status", "voucher_no"
          FROM "tabSerial No"
          ORDER BY "item", "serial_no"`,
  },
  "item-price-list": {
    permDoctype: "Item Price",
    columns: [
      { key: "item_price", label: "Item Price" },
      { key: "item_code", label: "Item" },
      { key: "price_list", label: "Price List" },
      { key: "rate", label: "Rate" },
      { key: "valid_from", label: "Valid From" },
    ],
    // All item prices with their price list and effective-from date.
    sql: `SELECT "name" AS "item_price", "item_code", "price_list",
                 coalesce("rate", 0)::float8 AS "rate", "valid_from"
          FROM "tabItem Price"
          ORDER BY "item_code", "price_list", "valid_from" DESC NULLS LAST`,
  },
  "work-order-by-sales-order": {
    permDoctype: "Work Order",
    columns: [
      { key: "sales_order", label: "Sales Order" },
      { key: "work_order", label: "Work Order" },
      { key: "production_item", label: "Item" },
      { key: "qty", label: "Qty" },
      { key: "status", label: "Status" },
    ],
    // Work orders raised from a Sales Order (make-to-order), with their production status.
    sql: `SELECT "sales_order", "name" AS "work_order", "production_item",
                 coalesce("qty", 0)::float8 AS "qty", coalesce("status", 'Draft') AS "status"
          FROM "tabWork Order"
          WHERE "sales_order" IS NOT NULL
          ORDER BY "sales_order", "name"`,
  },
  "work-order-status": {
    permDoctype: "Work Order",
    columns: [
      { key: "work_order", label: "Work Order" },
      { key: "production_item", label: "Item" },
      { key: "qty", label: "Qty" },
      { key: "status", label: "Status" },
      { key: "produced_value", label: "Produced Value" },
      { key: "stock_entry", label: "Stock Entry" },
    ],
    // Work orders with their production quantity, status, and manufacture stock entry.
    sql: `SELECT "name" AS "work_order", "production_item",
                 coalesce("qty", 0)::float8 AS "qty",
                 coalesce("status", 'Draft') AS "status",
                 coalesce("produced_value", 0)::float8 AS "produced_value",
                 "stock_entry"
          FROM "tabWork Order"
          ORDER BY "name"`,
  },
  "production-plan-status": {
    permDoctype: "Production Plan",
    columns: [
      { key: "production_plan", label: "Production Plan" },
      { key: "status", label: "Status" },
      { key: "item_count", label: "Planned Items" },
      { key: "planned_qty", label: "Total Planned Qty" },
      { key: "ordered_items", label: "Items Ordered" },
    ],
    // Production plans with their planned item count, total planned qty, and how many
    // planned lines have a Work Order raised.
    sql: `SELECT p."name" AS "production_plan", coalesce(p."status", 'Draft') AS "status",
                 count(i."name")::int AS "item_count",
                 coalesce(sum(i."planned_qty"), 0)::float8 AS "planned_qty",
                 count(i."work_order")::int AS "ordered_items"
          FROM "tabProduction Plan" p
          LEFT JOIN "tabProduction Plan Item" i ON i."parent" = p."name"
          GROUP BY p."name", p."status"
          ORDER BY p."name"`,
  },
  "loyalty-balance": {
    permDoctype: "Loyalty Point Entry",
    columns: [
      { key: "customer", label: "Customer" },
      { key: "earned", label: "Earned" },
      { key: "redeemed", label: "Redeemed" },
      { key: "balance", label: "Balance" },
    ],
    // Per customer: points earned (positive entries), redeemed (negatives), and net balance.
    sql: `SELECT "customer",
                 coalesce(sum("points") FILTER (WHERE "points" > 0), 0)::float8 AS "earned",
                 coalesce(-sum("points") FILTER (WHERE "points" < 0), 0)::float8 AS "redeemed",
                 coalesce(sum("points"), 0)::float8 AS "balance"
          FROM "tabLoyalty Point Entry"
          GROUP BY "customer"
          ORDER BY "balance" DESC, "customer"`,
  },
  "leave-balance": {
    permDoctype: "Leave Application",
    columns: [
      { key: "employee", label: "Employee" },
      { key: "leave_type", label: "Leave Type" },
      { key: "allocated", label: "Allocated" },
      { key: "used", label: "Used" },
      { key: "balance", label: "Balance" },
    ],
    // Per employee + leave type: submitted allocations minus submitted applications' days.
    sql: `WITH alloc AS (
            SELECT "employee", "leave_type", coalesce(sum("new_leaves_allocated"), 0)::float8 AS a
            FROM "tabLeave Allocation" WHERE "docstatus" = 1 GROUP BY "employee", "leave_type"
          ), used AS (
            SELECT "employee", "leave_type", coalesce(sum("total_leave_days"), 0)::float8 AS u
            FROM "tabLeave Application" WHERE "docstatus" = 1 GROUP BY "employee", "leave_type"
          )
          SELECT al."employee", al."leave_type",
                 al.a AS "allocated",
                 coalesce(us.u, 0) AS "used",
                 (al.a - coalesce(us.u, 0)) AS "balance"
          FROM alloc al
          LEFT JOIN used us ON us."employee" = al."employee" AND us."leave_type" = al."leave_type"
          ORDER BY al."employee", al."leave_type"`,
  },
  "unallocated-payments": {
    permDoctype: "Payment Entry",
    columns: [
      { key: "payment_entry", label: "Payment Entry" },
      { key: "posting_date", label: "Posting Date" },
      { key: "payment_type", label: "Type" },
      { key: "party", label: "Party" },
      { key: "paid_amount", label: "Paid Amount" },
      { key: "allocated", label: "Allocated" },
      { key: "unallocated", label: "Unallocated" },
    ],
    // Submitted payments whose paid amount exceeds what they allocated — on-account advances.
    sql: `SELECT p."name" AS "payment_entry", p."posting_date", p."payment_type", p."party",
                 coalesce(p."paid_amount", 0)::float8 AS "paid_amount",
                 coalesce(a.allocated, 0)::float8 AS "allocated",
                 (coalesce(p."paid_amount", 0) - coalesce(a.allocated, 0))::float8 AS "unallocated"
          FROM "tabPayment Entry" p
          LEFT JOIN (
            SELECT "parent", sum("allocated_amount") AS allocated
            FROM "tabPayment Entry Reference" GROUP BY "parent"
          ) a ON a."parent" = p."name"
          WHERE p."docstatus" = 1
            AND coalesce(p."paid_amount", 0) - coalesce(a.allocated, 0) > 0.0001
          ORDER BY p."posting_date" DESC, p."name"`,
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
  "coupon-usage": {
    permDoctype: "Coupon Code",
    columns: [
      { key: "coupon_code", label: "Coupon" },
      { key: "max_use", label: "Max Use" },
      { key: "used", label: "Used" },
      { key: "remaining", label: "Remaining" },
      { key: "valid_upto", label: "Valid Upto" },
      { key: "coupon_status", label: "Status" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    // Coupons with remaining uses and a derived status: Expired if past valid_upto,
    // Exhausted if a max is set and reached, else Active.
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT "name" AS "coupon_code",
                      coalesce("max_use", 0)::float8 AS "max_use",
                      coalesce("used", 0)::float8 AS "used",
                      CASE WHEN coalesce("max_use", 0) > 0
                           THEN (coalesce("max_use", 0) - coalesce("used", 0))::float8 ELSE NULL END AS "remaining",
                      "valid_upto",
                      CASE WHEN "valid_upto" IS NOT NULL AND "valid_upto"::date < $1::date THEN 'Expired'
                           WHEN coalesce("max_use", 0) > 0 AND coalesce("used", 0) >= "max_use" THEN 'Exhausted'
                           ELSE 'Active' END AS "coupon_status"
               FROM "tabCoupon Code"
               ORDER BY "valid_upto" NULLS LAST, "name"`,
        params: [asOf],
      };
    },
  },
  "bank-guarantee-status": {
    permDoctype: "Bank Guarantee",
    columns: [
      { key: "bank_guarantee", label: "Bank Guarantee" },
      { key: "bg_type", label: "Type" },
      { key: "party", label: "Party" },
      { key: "amount", label: "Amount" },
      { key: "end_date", label: "End Date" },
      { key: "days_to_expiry", label: "Days to Expiry" },
      { key: "status", label: "Status" },
    ],
    filters: [{ fieldname: "as_of", label: "As Of", fieldtype: "Date" }],
    // Submitted bank guarantees with their days to expiry (relative to as_of).
    build: (f) => {
      const asOf = f.as_of || today();
      return {
        text: `SELECT "name" AS "bank_guarantee", "bg_type", "party", "amount", "end_date",
                      CASE WHEN "end_date" IS NULL THEN NULL
                           ELSE ("end_date"::date - $1::date) END AS "days_to_expiry",
                      "status"
               FROM "tabBank Guarantee"
               WHERE "docstatus" = 1
               ORDER BY "end_date" NULLS LAST, "name"`,
        params: [asOf],
      };
    },
  },
  "attendance-request-status": {
    permDoctype: "Attendance Request",
    columns: [
      { key: "attendance_request", label: "Attendance Request" },
      { key: "employee", label: "Employee" },
      { key: "from_date", label: "From" },
      { key: "to_date", label: "To" },
      { key: "days", label: "Days" },
      { key: "attendance_status", label: "Mark As" },
      { key: "request_status", label: "Request Status" },
    ],
    // Attendance regularization requests with their inclusive day span and status.
    sql: `SELECT "name" AS "attendance_request", "employee", "from_date", "to_date",
                 CASE WHEN "from_date" IS NULL OR "to_date" IS NULL THEN NULL
                      ELSE ("to_date"::date - "from_date"::date + 1) END AS "days",
                 "attendance_status",
                 coalesce("request_status", 'Draft') AS "request_status"
          FROM "tabAttendance Request"
          ORDER BY "from_date" DESC, "name"`,
  },
  "warehouse-capacity": {
    permDoctype: "Warehouse",
    columns: [
      { key: "warehouse", label: "Warehouse" },
      { key: "max_capacity", label: "Capacity" },
      { key: "on_hand", label: "On Hand" },
      { key: "available", label: "Available" },
      { key: "utilization_pct", label: "Utilization %" },
    ],
    // Capacity-limited warehouses with their total on-hand units and remaining
    // headroom (capacity − on-hand).
    sql: `SELECT w."name" AS "warehouse",
                 coalesce(w."max_capacity", 0)::float8 AS "max_capacity",
                 coalesce(b."qty", 0)::float8 AS "on_hand",
                 (coalesce(w."max_capacity", 0) - coalesce(b."qty", 0))::float8 AS "available",
                 CASE WHEN coalesce(w."max_capacity", 0) > 0
                      THEN round((coalesce(b."qty", 0) / w."max_capacity" * 100)::numeric, 2)
                      ELSE 0 END AS "utilization_pct"
          FROM "tabWarehouse" w
          LEFT JOIN (
            SELECT "warehouse", sum("actual_qty") AS "qty" FROM "tabBin" GROUP BY "warehouse"
          ) b ON b."warehouse" = w."name"
          WHERE coalesce(w."max_capacity", 0) > 0
          ORDER BY w."name"`,
  },
  "pick-list-shortfall": {
    permDoctype: "Pick List",
    columns: [
      { key: "pick_list", label: "Pick List" },
      { key: "item_code", label: "Item" },
      { key: "to_pick_qty", label: "To Pick" },
      { key: "picked_qty", label: "Picked" },
      { key: "shortfall_qty", label: "Short" },
      { key: "status", label: "Status" },
    ],
    // Per pick-list line: quantity to pick vs actually picked and the shortfall
    // (positive when the warehouse could not fully pick the line).
    sql: `SELECT p."name" AS "pick_list", l."item_code",
                 coalesce(l."qty", 0)::float8 AS "to_pick_qty",
                 coalesce(l."picked_qty", 0)::float8 AS "picked_qty",
                 (coalesce(l."qty", 0) - coalesce(l."picked_qty", 0))::float8 AS "shortfall_qty",
                 coalesce(p."status", 'Draft') AS "status"
          FROM "tabPick List" p
          JOIN "tabPick List Item" l ON l."parent" = p."name"
          WHERE p."docstatus" = 1
          ORDER BY p."name", l."item_code"`,
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
