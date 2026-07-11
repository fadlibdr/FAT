import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Quality control. Two pure event-bus behaviours, no cross-module imports:
 *
 *  1. before_save on a Quality Inspection derives its overall status from the
 *     readings grid — Rejected if any reading is Rejected, else Accepted.
 *  2. before_submit on a Purchase Receipt gates the transition: any received
 *     item whose Item requires incoming inspection must have a submitted,
 *     Accepted Quality Inspection referencing this receipt, or submit is blocked.
 */
@Injectable()
export class QualityListener {
  private readonly logger = new Logger(QualityListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Quality Inspection")
  onInspectionSave(payload: BeforeSavePayload): void {
    const readings = payload.data.readings as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(readings)) return;
    const rejected = readings.some((r) => String(r?.acceptance ?? "Accepted") === "Rejected");
    payload.data.status = rejected ? "Rejected" : "Accepted";
  }

  // suppressErrors:false so a thrown gate error rejects emitAsync and aborts the
  // submit, rather than being swallowed and logged by the event emitter.
  @OnEvent("doc.before_submit:Purchase Receipt", { suppressErrors: false })
  async gatePurchaseReceipt(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Quality Inspection") || !this.registry.has("Item")) return;
    const doc = payload.doc;
    const items = (doc.items as Array<Record<string, unknown>>) ?? [];
    for (const row of items) {
      const item = String(row.item_code ?? "");
      if (!item || !(await this.inspectionRequired(item))) continue;
      const accepted = await this.hasAcceptedInspection(String(doc.name), item);
      if (!accepted) {
        throw new BadRequestException(
          `Purchase Receipt ${doc.name}: item ${item} requires an accepted Quality Inspection before it can be submitted`,
        );
      }
    }
    this.logger.log(`Purchase Receipt ${doc.name} passed quality gate`);
  }

  private async inspectionRequired(item: string): Promise<boolean> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("inspection_required_before_purchase")} AS req
         FROM ${quoteIdent(tableNameFor("Item"))} WHERE ${quoteIdent("name")} = $1`,
        [item],
      )
    )[0];
    return Number(row?.req ?? 0) === 1;
  }

  private async hasAcceptedInspection(reference: string, item: string): Promise<boolean> {
    const row = (
      await this.dataSource.query(
        `SELECT count(*) AS c FROM ${quoteIdent(tableNameFor("Quality Inspection"))}
         WHERE ${quoteIdent("reference_name")} = $1 AND ${quoteIdent("item_code")} = $2
           AND ${quoteIdent("status")} = 'Accepted' AND ${quoteIdent("docstatus")} = 1`,
        [reference, item],
      )
    )[0];
    return Number(row?.c ?? 0) > 0;
  }
}
