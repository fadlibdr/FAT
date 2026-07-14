import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Supplier performance. Pure event-bus listener, no cross-module imports:
 *
 *  1. before_save on a Supplier Scorecard computes the weighted total score
 *     (Σ weight·score / Σ weight) and its standing band.
 *  2. before_submit on a Purchase Order blocks ordering from a supplier whose
 *     most recent submitted scorecard rates them Poor.
 */
@Injectable()
export class ScorecardListener {
  private readonly logger = new Logger(ScorecardListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private standingOf(score: number): string {
    if (score >= 80) return "Excellent";
    if (score >= 60) return "Good";
    if (score >= 40) return "Average";
    return "Poor";
  }

  @OnEvent("doc.before_save:Supplier Scorecard")
  onScorecardSave(payload: BeforeSavePayload): void {
    const rows = (payload.data.criteria as Array<Record<string, unknown>>) ?? [];
    let weighted = 0;
    let weight = 0;
    for (const r of rows) {
      const w = Number(r.weight ?? 0);
      const s = Number(r.score ?? 0);
      weighted += w * s;
      weight += w;
    }
    const total = weight > 0 ? Math.round((weighted / weight) * 100) / 100 : 0;
    payload.data.total_score = total;
    payload.data.standing = this.standingOf(total);
  }

  /** The standing on a supplier's most recent submitted scorecard, if any. */
  private async latestStanding(supplier: string): Promise<string | undefined> {
    if (!this.registry.has("Supplier Scorecard")) return undefined;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("standing")} AS standing
         FROM ${quoteIdent(tableNameFor("Supplier Scorecard"))}
         WHERE ${quoteIdent("supplier")} = $1 AND ${quoteIdent("docstatus")} = 1
         ORDER BY ${quoteIdent("evaluation_date")} DESC, ${quoteIdent("creation")} DESC
         LIMIT 1`,
        [supplier],
      )
    )[0];
    return row?.standing ? String(row.standing) : undefined;
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Purchase Order", { suppressErrors: false })
  async gatePurchaseOrder(payload: DocEventPayload): Promise<void> {
    const supplier = String(payload.doc.supplier ?? "");
    if (!supplier) return;
    const standing = await this.latestStanding(supplier);
    if (standing === "Poor") {
      throw new BadRequestException(
        `Purchase Order ${payload.doc.name}: supplier ${supplier} has a Poor scorecard standing — ordering is blocked`,
      );
    }
    this.logger.log(`Purchase Order ${payload.doc.name} passed supplier scorecard gate`);
  }
}
