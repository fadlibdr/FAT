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
