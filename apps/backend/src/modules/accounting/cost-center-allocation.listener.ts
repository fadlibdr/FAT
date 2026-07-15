import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Cost Center Allocation reallocates a "main" cost center's booked balance across
 * several target cost centers by percentage. On submit, for every account the
 * main cost center carries a balance on within the period, it posts a reclass GL
 * voucher — crediting the main center and debiting the targets pro-rata on the
 * same account — so the account's total is unchanged but its cost-center split is
 * redistributed. Cancel removes the reclass. Pure event-bus listener; Accounting
 * owns the GL, so no cross-module imports.
 */
@Injectable()
export class CostCenterAllocationListener {
  private readonly logger = new Logger(CostCenterAllocationListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Normalize a date value (string or JS Date) to YYYY-MM-DD for SQL date params. */
  private isoDay(value: unknown, fallback: string): string {
    if (!value) return fallback;
    if (value instanceof Date) {
      const y = value.getUTCFullYear();
      const m = String(value.getUTCMonth() + 1).padStart(2, "0");
      const d = String(value.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
  }

  private targets(doc: Record<string, unknown>): Array<{ cost_center: string; percentage: number }> {
    return ((doc.allocations as Array<Record<string, unknown>>) ?? [])
      .map((r) => ({ cost_center: String(r.cost_center ?? ""), percentage: Number(r.percentage ?? 0) }))
      .filter((r) => r.cost_center && r.percentage);
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Cost Center Allocation", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const main = String(doc.main_cost_center ?? "");
    if (!main) throw new BadRequestException("A main cost center is required");
    const rows = this.targets(doc);
    if (rows.length === 0) throw new BadRequestException("At least one allocation percentage is required");
    if (rows.some((r) => r.cost_center === main)) {
      throw new BadRequestException(`A cost center cannot allocate to itself (${main})`);
    }
    const total = rows.reduce((s, r) => s + r.percentage, 0);
    if (Math.abs(total - 100) > 0.01) {
      throw new BadRequestException(`Allocation percentages must sum to 100 (got ${total})`);
    }
  }

  @OnEvent("doc.on_submit:Cost Center Allocation")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const glDt = this.registry.get("GL Entry");
    if (!glDt) return;
    const main = String(doc.main_cost_center ?? "");
    const rows = this.targets(doc);
    const ctx = systemContext(payload.user);
    const from = this.isoDay(doc.from_date, "1900-01-01");
    const to = this.isoDay(doc.to_date, "9999-12-31");

    // Net balance the main cost center holds on each account within the period.
    const balances = await this.dataSource.query(
      `SELECT ${quoteIdent("account")} AS account,
              coalesce(sum(${quoteIdent("debit")}), 0) - coalesce(sum(${quoteIdent("credit")}), 0) AS bal
       FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("cost_center")} = $1
         AND ${quoteIdent("posting_date")} >= $2 AND ${quoteIdent("posting_date")} <= $3
       GROUP BY ${quoteIdent("account")}
       HAVING abs(coalesce(sum(${quoteIdent("debit")}), 0) - coalesce(sum(${quoteIdent("credit")}), 0)) > 0.005`,
      [main, from, to],
    );

    let posted = 0;
    try {
      for (const row of balances as Array<{ account: string; bal: unknown }>) {
        const account = String(row.account);
        const bal = Number(row.bal ?? 0);
        // Move the whole balance off the main cost center (net -bal) …
        await this.postLine(glDt, ctx, doc, account, main, -bal);
        // … onto the targets pro-rata (net +bal × pct).
        for (const t of rows) {
          await this.postLine(glDt, ctx, doc, account, t.cost_center, (bal * t.percentage) / 100);
        }
        posted += 1;
      }
      this.logger.log(`Cost Center Allocation ${doc.name}: reallocated ${posted} account(s) from ${main}`);
    } catch (err) {
      this.logger.error(`Cost Center Allocation ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  /** Post one reclass GL line; `net` is the desired debit − credit for the line. */
  private async postLine(
    glDt: ReturnType<DoctypeRegistryService["get"]>,
    ctx: ReturnType<typeof systemContext>,
    doc: Record<string, unknown>,
    account: string,
    costCenter: string,
    net: number,
  ): Promise<void> {
    if (Math.abs(net) < 0.005 || !glDt) return;
    await this.documents.create(glDt, ctx, {
      posting_date: doc.to_date ?? doc.from_date ?? null,
      voucher_type: "Cost Center Allocation",
      voucher_no: String(doc.name),
      account,
      cost_center: costCenter,
      debit: net > 0 ? Math.round(net * 100) / 100 : 0,
      credit: net < 0 ? Math.round(-net * 100) / 100 : 0,
      against: `Cost Center Allocation ${doc.name}`,
    });
  }

  @OnEvent("doc.on_cancel:Cost Center Allocation")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Cost Center Allocation' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
