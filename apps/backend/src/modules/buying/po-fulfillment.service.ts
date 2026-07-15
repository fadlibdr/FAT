import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Purchase Order fulfillment — the buying-side mirror of Selling's
 * FulfillmentService. Recomputes a Purchase Order's received / billed
 * percentages and status from the submitted (non-return) Purchase Receipts and
 * Purchase Invoices referencing it, and converts an order into a draft receipt
 * or bill. Pure SQL over sibling tables; no cross-module service imports.
 */
@Injectable()
export class PoFulfillmentService {
  private readonly logger = new Logger(PoFulfillmentService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async recomputePurchaseOrder(po: string): Promise<void> {
    if (!this.registry.has("Purchase Order") || !po) return;
    const ordered = await this.qtyByItem("Purchase Order Item", "Purchase Order", "name", po, false);
    const received = await this.qtyByItem("Purchase Receipt Item", "Purchase Receipt", "purchase_order", po, true);
    const billed = await this.qtyByItem("Purchase Invoice Item", "Purchase Invoice", "purchase_order", po, true);

    const perReceived = this.progress(ordered, received);
    const perBilled = this.progress(ordered, billed);
    const status = this.status(perReceived, perBilled);

    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Purchase Order"))}
       SET ${quoteIdent("per_received")} = $1, ${quoteIdent("per_billed")} = $2, ${quoteIdent("status")} = $3
       WHERE ${quoteIdent("name")} = $4`,
      [perReceived, perBilled, status, po],
    );
    this.logger.log(`Purchase Order ${po}: received ${perReceived}% billed ${perBilled}% -> ${status}`);
  }

  /** Create a draft Purchase Receipt or Purchase Invoice pre-filled from a Purchase Order. */
  async makeFromPurchaseOrder(
    po: string,
    target: "Purchase Receipt" | "Purchase Invoice",
    ctx?: UserContext,
  ): Promise<string> {
    const poDt = this.registry.get("Purchase Order");
    const tgtDt = this.registry.get(target);
    if (!poDt || !tgtDt) throw new BadRequestException(`${target} not registered`);
    const context = ctx ?? systemContext();
    const order = await this.documents.get(poDt, po);
    if ((order.docstatus ?? 0) !== 1) throw new BadRequestException("Purchase Order must be submitted");

    const items = ((order.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      rate: Number(r.rate ?? 0),
    }));
    const doc = await this.documents.create(tgtDt, context, {
      supplier: order.supplier,
      posting_date: new Date().toISOString().slice(0, 10),
      purchase_order: po,
      items,
    });
    this.logger.log(`Purchase Order ${po} -> ${target} ${doc.name}`);
    return String(doc.name);
  }

  /**
   * Create a draft Purchase Invoice billing a submitted Purchase Receipt. Copies
   * the received lines and carries the receipt's own Purchase Order link, so the
   * order's per_billed recomputes as usual; stamps the receipt with the invoice.
   * Refuses a non-submitted receipt or one already billed.
   */
  async makePurchaseInvoiceFromReceipt(pr: string, ctx?: UserContext): Promise<string> {
    const prDt = this.registry.get("Purchase Receipt");
    const piDt = this.registry.get("Purchase Invoice");
    if (!prDt || !piDt) throw new BadRequestException("Purchase Receipt or Purchase Invoice not registered");
    const context = ctx ?? systemContext();
    const receipt = await this.documents.get(prDt, pr);
    if ((receipt.docstatus ?? 0) !== 1) throw new BadRequestException("Purchase Receipt must be submitted");
    if (receipt.purchase_invoice) {
      throw new BadRequestException(`Purchase Receipt ${pr} already billed via ${receipt.purchase_invoice}`);
    }

    const items = ((receipt.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      rate: Number(r.rate ?? 0),
    }));
    const pi = await this.documents.create(piDt, context, {
      supplier: receipt.supplier,
      posting_date: new Date().toISOString().slice(0, 10),
      purchase_order: receipt.purchase_order ?? null,
      purchase_receipt: pr,
      items,
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Purchase Receipt"))}
       SET ${quoteIdent("purchase_invoice")} = $1 WHERE ${quoteIdent("name")} = $2`,
      [String(pi.name), pr],
    );
    this.logger.log(`Purchase Receipt ${pr} -> Purchase Invoice ${pi.name}`);
    return String(pi.name);
  }

  /**
   * Create a draft Debit Note (return Purchase Invoice) against a submitted bill:
   * mirrors the original lines at negative quantity and marks is_return with
   * return_against set. On submit the GL-posting listener reverses the original
   * posting (Dr Creditors / Cr expense) and books a negative outstanding. Refuses a
   * non-submitted invoice or one that is itself a return.
   */
  async makePurchaseReturn(pi: string, ctx?: UserContext): Promise<string> {
    const piDt = this.registry.get("Purchase Invoice");
    if (!piDt) throw new BadRequestException("Purchase Invoice not registered");
    const context = ctx ?? systemContext();
    const inv = await this.documents.get(piDt, pi);
    if ((inv.docstatus ?? 0) !== 1) throw new BadRequestException("Purchase Invoice must be submitted");
    if (Boolean(inv.is_return)) throw new BadRequestException(`Purchase Invoice ${pi} is already a return`);

    const items = ((inv.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: -Math.abs(Number(r.qty ?? 0)),
      rate: Number(r.rate ?? 0),
    }));
    const debit = await this.documents.create(piDt, context, {
      supplier: inv.supplier,
      posting_date: new Date().toISOString().slice(0, 10),
      is_return: 1,
      return_against: pi,
      purchase_order: inv.purchase_order ?? null,
      items,
    });
    this.logger.log(`Purchase Invoice ${pi} -> Debit Note ${debit.name}`);
    return String(debit.name);
  }

  private async qtyByItem(
    childDoctype: string,
    parentDoctype: string,
    field: string,
    value: string,
    linked: boolean,
  ): Promise<Map<string, number>> {
    if (!this.registry.has(childDoctype)) return new Map();
    const hasReturn = this.registry.get(parentDoctype)?.fields.some((f) => f.fieldname === "is_return");
    const extra = linked
      ? `AND p.${quoteIdent("docstatus")} = 1` +
        (hasReturn ? ` AND coalesce(p.${quoteIdent("is_return")}, 0) = 0` : "")
      : "";
    const rows = await this.dataSource.query(
      `SELECT c.${quoteIdent("item_code")} AS item, coalesce(sum(c.${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor(childDoctype))} c
       JOIN ${quoteIdent(tableNameFor(parentDoctype))} p ON p.${quoteIdent("name")} = c.${quoteIdent("parent")}
       WHERE p.${quoteIdent(field)} = $1 ${extra}
       GROUP BY c.${quoteIdent("item_code")}`,
      [value],
    );
    const map = new Map<string, number>();
    for (const r of rows) map.set(String(r.item), Number(r.qty));
    return map;
  }

  private progress(ordered: Map<string, number>, done: Map<string, number>): number {
    let totalOrdered = 0;
    let totalDone = 0;
    for (const [item, qty] of ordered) {
      totalOrdered += qty;
      totalDone += Math.min(done.get(item) ?? 0, qty);
    }
    return totalOrdered > 0 ? Math.round((totalDone / totalOrdered) * 10000) / 100 : 0;
  }

  private status(perReceived: number, perBilled: number): string {
    const received = perReceived >= 99.99;
    const billed = perBilled >= 99.99;
    if (received && billed) return "Completed";
    if (billed) return "To Receive";
    if (received) return "To Bill";
    return "To Receive and Bill";
  }
}
