import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/** Tolerance so floating-point sums don't trip an exact-quantity comparison. */
const TOL = 0.0001;

/**
 * Subcontracting: a Subcontracting Order sends raw materials to a subcontractor
 * who returns a finished item. `makeSubcontractingReceipt` drafts a receipt for
 * the still-outstanding finished quantity; on the receipt's submit (or cancel)
 * the order's `per_received` and status are recomputed (To Receive → Completed).
 * Qty/status tracking only — no stock/GL valuation (see docs). Pure use of the
 * generic DocumentService over sibling tables; no cross-module service imports.
 */
@Injectable()
export class SubcontractingService {
  private readonly logger = new Logger(SubcontractingService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Draft a Subcontracting Receipt for a submitted order's outstanding finished
   * quantity (ordered − already received on other submitted receipts). Refuses a
   * non-submitted or already fully-received order.
   */
  async makeSubcontractingReceipt(orderName: string, ctx?: UserContext): Promise<string> {
    const scoDt = this.registry.get("Subcontracting Order");
    const scrDt = this.registry.get("Subcontracting Receipt");
    if (!scoDt || !scrDt) throw new BadRequestException("Subcontracting Order / Receipt not registered");
    const context = ctx ?? systemContext();

    const order = await this.documents.get(scoDt, orderName);
    if ((order.docstatus ?? 0) !== 1) throw new BadRequestException("Subcontracting Order must be submitted");
    const ordered = Number(order.qty ?? 0);
    const received = await this.receivedQty(orderName);
    const remaining = ordered - received;
    if (remaining <= TOL) throw new BadRequestException(`Subcontracting Order ${orderName} is already fully received`);

    const receipt = await this.documents.create(scrDt, context, {
      supplier: order.supplier,
      subcontracting_order: orderName,
      posting_date: new Date().toISOString().slice(0, 10),
      finished_item: order.finished_item,
      qty: remaining,
    });
    this.logger.log(`Subcontracting Order ${orderName} -> Receipt ${receipt.name} (qty ${remaining})`);
    return String(receipt.name);
  }

  @OnEvent("doc.on_submit:Subcontracting Receipt")
  async onReceiptSubmit(payload: DocEventPayload): Promise<void> {
    await this.recompute(String(payload.doc.subcontracting_order ?? ""));
  }

  @OnEvent("doc.on_cancel:Subcontracting Receipt")
  async onReceiptCancel(payload: DocEventPayload): Promise<void> {
    await this.recompute(String(payload.doc.subcontracting_order ?? ""));
  }

  @OnEvent("doc.on_submit:Subcontracting Order")
  async onOrderSubmit(payload: DocEventPayload): Promise<void> {
    await this.recompute(String(payload.doc.name));
  }

  /** Recompute an order's per_received and status from its submitted receipts. */
  private async recompute(orderName: string): Promise<void> {
    if (!orderName || !this.registry.has("Subcontracting Order")) return;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("qty")} AS qty FROM ${quoteIdent(tableNameFor("Subcontracting Order"))}
         WHERE ${quoteIdent("name")} = $1`,
        [orderName],
      )
    )[0];
    const ordered = Number(row?.qty ?? 0);
    const received = await this.receivedQty(orderName);
    const per = ordered > 0 ? Math.min(100, Math.round((received / ordered) * 10000) / 100) : 0;
    const status = per >= 99.99 ? "Completed" : "To Receive";
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Subcontracting Order"))}
       SET ${quoteIdent("per_received")} = $1, ${quoteIdent("status")} = $2 WHERE ${quoteIdent("name")} = $3`,
      [per, status, orderName],
    );
    this.logger.log(`Subcontracting Order ${orderName}: received ${per}% -> ${status}`);
  }

  /** Finished quantity received against an order (submitted receipts only). */
  private async receivedQty(orderName: string): Promise<number> {
    if (!this.registry.has("Subcontracting Receipt")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("qty")}), 0) AS q
         FROM ${quoteIdent(tableNameFor("Subcontracting Receipt"))}
         WHERE ${quoteIdent("subcontracting_order")} = $1 AND ${quoteIdent("docstatus")} = 1`,
        [orderName],
      )
    )[0];
    return Number(row?.q ?? 0);
  }

  // suppressErrors:false so an over-receipt aborts the submit.
  @OnEvent("doc.before_submit:Subcontracting Receipt", { suppressErrors: false })
  async gateReceipt(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const orderName = String(doc.subcontracting_order ?? "");
    if (!orderName || !this.registry.has("Subcontracting Order")) return;
    const order = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("qty")} AS qty FROM ${quoteIdent(tableNameFor("Subcontracting Order"))}
         WHERE ${quoteIdent("name")} = $1`,
        [orderName],
      )
    )[0];
    if (!order) throw new BadRequestException(`Subcontracting Order ${orderName} not found`);
    const ordered = Number(order.qty ?? 0);
    const already = await this.receivedQty(orderName);
    const incoming = Number(doc.qty ?? 0);
    if (already + incoming > ordered + TOL) {
      throw new BadRequestException(
        `Subcontracting Receipt ${doc.name}: received ${already + incoming} exceeds ` +
          `Subcontracting Order ${orderName} ordered ${ordered} (already received ${already})`,
      );
    }
  }
}
