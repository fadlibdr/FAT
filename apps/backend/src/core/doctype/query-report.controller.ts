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
