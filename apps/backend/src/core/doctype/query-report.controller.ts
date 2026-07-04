import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { PermType } from "@fat/shared";
import { PermissionService } from "../permissions/permission.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../permissions/permission.service";

interface QueryReport {
  /** DocType whose Report permission gates access. */
  permDoctype: string;
  columns: { key: string; label: string }[];
  sql: string;
}

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
                 "actual_qty"::float8 AS "actual_qty",
                 "valuation_rate"::float8 AS "valuation_rate",
                 "stock_value"::float8 AS "stock_value"
          FROM "tabBin" WHERE "actual_qty" <> 0
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
};

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
      })),
    };
  }

  @Get(":name")
  async run(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const report = REPORTS[name];
    if (!report) throw new NotFoundException(`Unknown report: ${name}`);
    await this.permissions.assertPerm(user, report.permDoctype, PermType.Report);
    const rows = await this.dataSource.query(report.sql);
    return { data: { columns: report.columns, rows } };
  }
}
