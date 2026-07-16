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
 *  1. before_save on a Quality Inspection evaluates each reading that carries a
 *     numeric spec (a min and/or max value) — the reading's acceptance is set
 *     from whether its reading_value falls in range — then derives the overall
 *     status from the readings grid: Rejected if any reading is Rejected, else
 *     Accepted. Readings without a numeric spec keep their manual acceptance.
 *  2. before_submit on a Purchase Receipt gates the transition: any received
 *     item whose Item requires incoming inspection must have a submitted,
 *     Accepted Quality Inspection referencing this receipt, or submit is blocked.
 *  3. before_submit on a Delivery Note gates the same way for outgoing goods,
 *     keyed on the Item's before-delivery inspection flag.
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
    for (const r of readings) {
      const verdict = QualityListener.evaluate(r);
      if (verdict) r.acceptance = verdict; // numeric spec overrides the manual field
    }
    const rejected = readings.some((r) => String(r?.acceptance ?? "Accepted") === "Rejected");
    payload.data.status = rejected ? "Rejected" : "Accepted";
  }

  /** A finite number or null (treats null/undefined/blank as "unset"). */
  private static num(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Acceptance for a reading with a numeric spec: Accepted when reading_value is
   * within [min, max] (either bound optional), Rejected otherwise. Returns null
   * when the reading has no numeric spec, leaving its manual acceptance untouched.
   */
  private static evaluate(r: Record<string, unknown>): "Accepted" | "Rejected" | null {
    const min = QualityListener.num(r.min_value);
    const max = QualityListener.num(r.max_value);
    if (min === null && max === null) return null; // qualitative reading
    const value = QualityListener.num(r.reading_value);
    if (value === null) return "Rejected"; // a numeric spec with a non-numeric reading fails
    if (min !== null && value < min) return "Rejected";
    if (max !== null && value > max) return "Rejected";
    return "Accepted";
  }

  // suppressErrors:false so a bad inspection aborts the submit.
  @OnEvent("doc.before_submit:Quality Inspection", { suppressErrors: false })
  gateInspection(payload: DocEventPayload): void {
    const readings = (payload.doc.readings as Array<Record<string, unknown>>) ?? [];
    if (readings.length === 0) {
      throw new BadRequestException(`Quality Inspection ${payload.doc.name}: at least one reading is required`);
    }
    for (const r of readings) {
      const min = QualityListener.num(r.min_value);
      const max = QualityListener.num(r.max_value);
      if (min !== null && max !== null && min > max) {
        throw new BadRequestException(
          `Quality Inspection ${payload.doc.name}: parameter "${r.parameter}" has min ${min} greater than max ${max}`,
        );
      }
      if ((min !== null || max !== null) && QualityListener.num(r.reading_value) === null) {
        throw new BadRequestException(
          `Quality Inspection ${payload.doc.name}: parameter "${r.parameter}" needs a numeric reading for its spec range`,
        );
      }
    }
  }

  // suppressErrors:false so a thrown gate error rejects emitAsync and aborts the
  // submit, rather than being swallowed and logged by the event emitter.
  @OnEvent("doc.before_submit:Purchase Receipt", { suppressErrors: false })
  async gatePurchaseReceipt(payload: DocEventPayload): Promise<void> {
    await this.gate(payload.doc, "Purchase Receipt", "inspection_required_before_purchase");
  }

  @OnEvent("doc.before_submit:Delivery Note", { suppressErrors: false })
  async gateDeliveryNote(payload: DocEventPayload): Promise<void> {
    if (Boolean(payload.doc.is_return)) return; // returns bring goods back, no outgoing inspection
    await this.gate(payload.doc, "Delivery Note", "inspection_required_before_delivery");
  }

  /**
   * Block a submit when any line item flagged for inspection (per `flagColumn`)
   * lacks a submitted, Accepted Quality Inspection referencing this document.
   */
  private async gate(doc: Record<string, unknown>, label: string, flagColumn: string): Promise<void> {
    if (!this.registry.has("Quality Inspection") || !this.registry.has("Item")) return;
    const items = (doc.items as Array<Record<string, unknown>>) ?? [];
    for (const row of items) {
      const item = String(row.item_code ?? "");
      if (!item || !(await this.inspectionRequired(item, flagColumn))) continue;
      const accepted = await this.hasAcceptedInspection(String(doc.name), item);
      if (!accepted) {
        throw new BadRequestException(
          `${label} ${doc.name}: item ${item} requires an accepted Quality Inspection before it can be submitted`,
        );
      }
    }
    this.logger.log(`${label} ${doc.name} passed quality gate`);
  }

  private async inspectionRequired(item: string, flagColumn: string): Promise<boolean> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent(flagColumn)} AS req
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
