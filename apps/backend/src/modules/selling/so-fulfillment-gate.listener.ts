import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Small tolerance so floating-point sums don't trip an exact-quantity gate. */
const TOL = 0.0001;

/**
 * Sales-order fulfilment control. A Delivery Note may not deliver, and a Sales
 * Invoice may not bill, more of any item than the linked Sales Order ordered.
 * Before either is submitted, the already-delivered / already-billed quantity per
 * item (from other submitted documents against the same order) plus this document's
 * lines is checked against the ordered quantity, and an over-quantity aborts the
 * submit. A return (is_return) is exempt. Pure event-bus listener — reads via SQL,
 * no cross-module service imports.
 */
@Injectable()
export class SoFulfillmentGateListener {
  private readonly logger = new Logger(SoFulfillmentGateListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so an over-delivery aborts the submit.
  @OnEvent("doc.before_submit:Delivery Note", { suppressErrors: false })
  async gateDelivery(payload: DocEventPayload): Promise<void> {
    await this.gate("Delivery Note", "Delivery Note Item", payload.doc, "delivered");
  }

  @OnEvent("doc.before_submit:Sales Invoice", { suppressErrors: false })
  async gateInvoice(payload: DocEventPayload): Promise<void> {
    await this.gate("Sales Invoice", "Sales Invoice Item", payload.doc, "billed");
  }

  private async gate(
    parentType: string,
    childType: string,
    doc: Record<string, unknown>,
    verb: string,
  ): Promise<void> {
    if (Boolean(doc.is_return)) return; // a return reduces fulfilment
    const so = String(doc.sales_order ?? "");
    if (!so || !this.registry.has("Sales Order")) return;

    const ordered = await this.orderedByItem(so);
    if (ordered.size === 0) return;
    const already = await this.doneByItem(parentType, childType, so);

    const incoming = new Map<string, number>();
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      const qty = Number(row.qty ?? 0);
      if (!item || !qty) continue;
      incoming.set(item, (incoming.get(item) ?? 0) + qty);
    }

    for (const [item, qty] of incoming) {
      const orderedQty = ordered.get(item) ?? 0;
      const doneQty = already.get(item) ?? 0;
      if (doneQty + qty > orderedQty + TOL) {
        throw new BadRequestException(
          `${parentType} ${doc.name}: item ${item} ${verb} ${doneQty + qty} exceeds ` +
            `Sales Order ${so} ordered ${orderedQty} (already ${verb} ${doneQty})`,
        );
      }
    }
  }

  /** Ordered quantity per item on a Sales Order. */
  private async orderedByItem(so: string): Promise<Map<string, number>> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("item_code")} AS item, coalesce(sum(${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor("Sales Order Item"))} WHERE ${quoteIdent("parent")} = $1
       GROUP BY ${quoteIdent("item_code")}`,
      [so],
    );
    return new Map(rows.map((r) => [String(r.item), Number(r.qty ?? 0)]));
  }

  /** Quantity per item already delivered/billed against a SO (submitted docs only). */
  private async doneByItem(
    parentType: string,
    childType: string,
    so: string,
  ): Promise<Map<string, number>> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT c.${quoteIdent("item_code")} AS item, coalesce(sum(c.${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor(childType))} c
       JOIN ${quoteIdent(tableNameFor(parentType))} p ON c.${quoteIdent("parent")} = p.${quoteIdent("name")}
       WHERE p.${quoteIdent("sales_order")} = $1 AND p.${quoteIdent("docstatus")} = 1
         AND coalesce(p.${quoteIdent("is_return")}, 0) = 0
       GROUP BY c.${quoteIdent("item_code")}`,
      [so],
    );
    return new Map(rows.map((r) => [String(r.item), Number(r.qty ?? 0)]));
  }
}
