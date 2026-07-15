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
 * Three-way match. A Purchase Receipt may not receive, and a Purchase Invoice may
 * not bill, more of any item than the linked Purchase Order ordered. Before either
 * is submitted, the already-received / already-billed quantity per item (from other
 * submitted documents against the same PO) plus this document's lines is checked
 * against the ordered quantity, and an over-quantity aborts the submit. Pure
 * event-bus listener — reads via SQL, no cross-module service imports.
 */
@Injectable()
export class ThreeWayMatchListener {
  private readonly logger = new Logger(ThreeWayMatchListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so an over-receipt aborts the submit.
  @OnEvent("doc.before_submit:Purchase Receipt", { suppressErrors: false })
  async gateReceipt(payload: DocEventPayload): Promise<void> {
    await this.gate("Purchase Receipt", "Purchase Receipt Item", payload.doc, "received");
  }

  @OnEvent("doc.before_submit:Purchase Invoice", { suppressErrors: false })
  async gateInvoice(payload: DocEventPayload): Promise<void> {
    await this.gate("Purchase Invoice", "Purchase Invoice Item", payload.doc, "billed");
  }

  private async gate(
    parentType: string,
    childType: string,
    doc: Record<string, unknown>,
    verb: string,
  ): Promise<void> {
    const po = String(doc.purchase_order ?? "");
    if (!po || !this.registry.has("Purchase Order")) return;

    const ordered = await this.orderedByItem(po);
    if (ordered.size === 0) return;
    const already = await this.doneByItem(parentType, childType, po);

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
            `Purchase Order ${po} ordered ${orderedQty} (already ${verb} ${doneQty})`,
        );
      }
    }
  }

  /** Ordered quantity per item on a Purchase Order. */
  private async orderedByItem(po: string): Promise<Map<string, number>> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("item_code")} AS item, coalesce(sum(${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor("Purchase Order Item"))} WHERE ${quoteIdent("parent")} = $1
       GROUP BY ${quoteIdent("item_code")}`,
      [po],
    );
    return new Map(rows.map((r) => [String(r.item), Number(r.qty ?? 0)]));
  }

  /** Quantity per item already received/billed against a PO (submitted docs only). */
  private async doneByItem(
    parentType: string,
    childType: string,
    po: string,
  ): Promise<Map<string, number>> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT c.${quoteIdent("item_code")} AS item, coalesce(sum(c.${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor(childType))} c
       JOIN ${quoteIdent(tableNameFor(parentType))} p ON c.${quoteIdent("parent")} = p.${quoteIdent("name")}
       WHERE p.${quoteIdent("purchase_order")} = $1 AND p.${quoteIdent("docstatus")} = 1
       GROUP BY c.${quoteIdent("item_code")}`,
      [po],
    );
    return new Map(rows.map((r) => [String(r.item), Number(r.qty ?? 0)]));
  }
}
