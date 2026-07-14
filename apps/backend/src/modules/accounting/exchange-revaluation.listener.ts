import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const GAIN_LOSS = "Exchange Gain/Loss";

/** Round to 2 decimals. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Exchange rate revaluation. Restates open foreign-currency account balances at
 * a new rate and books the unrealised gain/loss to a P&L account. Pure event-bus
 * listener — Accounting posts GL via the generic DocumentService, no cross-module
 * service imports.
 *
 *  1. before_save computes each account row's gain/loss = balance × (new − current)
 *     rate, and the header total.
 *  2. on_submit posts, per account, the revaluation adjustment (Dr/Cr the account
 *     by its gain/loss) against the gain/loss account — a net-zero, balanced set.
 *  3. on_cancel reverses the GL.
 */
@Injectable()
export class ExchangeRevaluationListener {
  private readonly logger = new Logger(ExchangeRevaluationListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Exchange Rate Revaluation")
  onSave(payload: BeforeSavePayload): void {
    const rows = (payload.data.accounts as Array<Record<string, unknown>>) ?? [];
    let total = 0;
    for (const r of rows) {
      const balance = Number(r.balance ?? 0);
      const current = Number(r.current_exchange_rate ?? 0);
      const next = Number(r.new_exchange_rate ?? 0);
      const gainLoss = round2(balance * (next - current));
      r.gain_loss = gainLoss;
      total += gainLoss;
    }
    payload.data.total_gain_loss = round2(total);
  }

  @OnEvent("doc.on_submit:Exchange Rate Revaluation")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const glAccount = String(doc.gain_loss_account || GAIN_LOSS);

    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("account")} AS account, ${quoteIdent("party")} AS party,
              ${quoteIdent("gain_loss")} AS gain_loss
       FROM ${quoteIdent(tableNameFor("Exchange Rate Revaluation Account"))}
       WHERE ${quoteIdent("parent")} = $1`,
      [String(doc.name)],
    );

    try {
      for (const r of rows) {
        const gl = Number(r.gain_loss ?? 0);
        if (Math.abs(gl) < 0.005) continue;
        const account = String(r.account ?? "");
        const against = String(r.party ?? "");
        // A positive revaluation debits the account (its base value rose) and
        // credits the gain/loss account (a gain); a negative one does the reverse.
        const accDebit = gl > 0 ? gl : 0;
        const accCredit = gl < 0 ? -gl : 0;
        await this.post(dt, ctx, doc, account, accDebit, accCredit, against);
        await this.post(dt, ctx, doc, glAccount, accCredit, accDebit, account);
      }
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Exchange Rate Revaluation"))}
         SET ${quoteIdent("status")} = 'Submitted' WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(
        `Exchange Rate Revaluation ${doc.name}: booked ${doc.total_gain_loss} to ${glAccount}`,
      );
    } catch (err) {
      this.logger.error(`Exchange Rate Revaluation ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Exchange Rate Revaluation")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Exchange Rate Revaluation' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Exchange Rate Revaluation"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }

  private async post(
    dt: ReturnType<DoctypeRegistryService["get"]>,
    ctx: ReturnType<typeof systemContext>,
    doc: Record<string, unknown>,
    account: string,
    debit: number,
    credit: number,
    against: string,
  ): Promise<void> {
    if (!dt || (!debit && !credit)) return;
    await this.documents.create(dt, ctx, {
      posting_date: doc.posting_date ?? null,
      voucher_type: "Exchange Rate Revaluation",
      voucher_no: String(doc.name),
      account,
      debit,
      credit,
      against,
    });
  }
}
