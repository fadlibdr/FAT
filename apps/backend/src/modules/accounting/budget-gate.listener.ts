import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Budget control. Before a Purchase Invoice is submitted, its expense against a
 * budgeted account + cost center is checked against the Budget: if the cumulative
 * actual (already-posted GL) plus this bill would exceed the budget and the
 * budget's action is "Stop", the submit is blocked; "Warn" only logs; "Ignore"
 * does nothing. Pure event-bus listener — no cross-module service imports.
 */
@Injectable()
export class BudgetGateListener {
  private readonly logger = new Logger(BudgetGateListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so a Stop action aborts the submit.
  @OnEvent("doc.before_submit:Purchase Invoice", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (Boolean(doc.is_return)) return; // a debit note reduces spend
    if (!this.registry.has("Budget")) return;
    const account = String(doc.expense_account ?? "");
    const costCenter = String(doc.cost_center ?? "");
    if (!account || !costCenter) return;

    const budget = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("budget_amount")} AS amount,
                coalesce(${quoteIdent("action_if_annual_budget_exceeded")}, 'Warn') AS action
         FROM ${quoteIdent(tableNameFor("Budget"))}
         WHERE ${quoteIdent("account")} = $1 AND ${quoteIdent("cost_center")} = $2
         LIMIT 1`,
        [account, costCenter],
      )
    )[0];
    if (!budget) return;
    const action = String(budget.action);
    if (action === "Ignore") return;

    const limit = Number(budget.amount ?? 0);
    const actual = await this.actual(account, costCenter);
    const thisBill = Number(doc.total ?? 0);
    const projected = round2(actual + thisBill);
    if (projected <= limit + 0.0001) return;

    const message =
      `Budget for ${account} / ${costCenter} exceeded: actual ${round2(actual)} + this ${round2(thisBill)} ` +
      `= ${projected} > budget ${limit}`;
    if (action === "Stop") {
      throw new BadRequestException(`Purchase Invoice ${doc.name}: ${message}`);
    }
    this.logger.warn(`Purchase Invoice ${doc.name}: ${message} (Warn)`);
  }

  /** Cumulative actual spend (Σ debit − credit) on an account + cost center. */
  private async actual(account: string, costCenter: string): Promise<number> {
    if (!this.registry.has("GL Entry")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("debit")}) - sum(${quoteIdent("credit")}), 0) AS actual
         FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("account")} = $1 AND ${quoteIdent("cost_center")} = $2`,
        [account, costCenter],
      )
    )[0];
    return Number(row?.actual ?? 0);
  }
}
