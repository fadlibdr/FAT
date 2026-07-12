import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Sales Order fulfillment. Recomputes a Sales Order's delivered / billed
 * percentages and status from the submitted (non-return) Delivery Notes and
 * Sales Invoices that reference it. Per item, progress is capped at the ordered
 * quantity so over-shipping one line can't mask a short on another. Pure SQL
 * over sibling tables — Selling imports no other module's services.
 */
@Injectable()
export class FulfillmentService {
  private readonly logger = new Logger(FulfillmentService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Create a draft Delivery Note or Sales Invoice pre-filled from a Sales Order. */
  async makeFromSalesOrder(
    so: string,
    target: "Delivery Note" | "Sales Invoice",
    ctx?: UserContext,
  ): Promise<string> {
    const soDt = this.registry.get("Sales Order");
    const tgtDt = this.registry.get(target);
    if (!soDt || !tgtDt) throw new BadRequestException(`${target} not registered`);
    const context = ctx ?? systemContext();
    const order = await this.documents.get(soDt, so);
    if ((order.docstatus ?? 0) !== 1) throw new BadRequestException("Sales Order must be submitted");

    const items = ((order.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      rate: Number(r.rate ?? 0),
    }));
    const doc = await this.documents.create(tgtDt, context, {
      customer: order.customer,
      posting_date: new Date().toISOString().slice(0, 10),
      sales_order: so,
      items,
    });
    this.logger.log(`Sales Order ${so} -> ${target} ${doc.name}`);
    return String(doc.name);
  }

  async recomputeSalesOrder(so: string): Promise<void> {
    if (!this.registry.has("Sales Order") || !so) return;
    const ordered = await this.qtyByItem("Sales Order Item", "Sales Order", "name", so, false);
    const delivered = await this.qtyByItem("Delivery Note Item", "Delivery Note", "sales_order", so, true);
    const billed = await this.qtyByItem("Sales Invoice Item", "Sales Invoice", "sales_order", so, true);

    const { perDone: perDelivered } = this.progress(ordered, delivered);
    const { perDone: perBilled } = this.progress(ordered, billed);
    const status = this.status(perDelivered, perBilled);

    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Sales Order"))}
       SET ${quoteIdent("per_delivered")} = $1, ${quoteIdent("per_billed")} = $2, ${quoteIdent("status")} = $3
       WHERE ${quoteIdent("name")} = $4`,
      [perDelivered, perBilled, status, so],
    );
    this.logger.log(`Sales Order ${so}: delivered ${perDelivered}% billed ${perBilled}% -> ${status}`);
  }

  /**
   * Sum of a child table's qty per item_code, for parents matching `field=value`.
   * `linked` parents (Delivery Note / invoices) are filtered to submitted
   * non-returns; the order document itself is read as-is.
   */
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

  /** Aggregate % done = Σ min(done_i, ordered_i) / Σ ordered_i. */
  private progress(ordered: Map<string, number>, done: Map<string, number>): { perDone: number } {
    let totalOrdered = 0;
    let totalDone = 0;
    for (const [item, qty] of ordered) {
      totalOrdered += qty;
      totalDone += Math.min(done.get(item) ?? 0, qty);
    }
    const perDone = totalOrdered > 0 ? Math.round((totalDone / totalOrdered) * 10000) / 100 : 0;
    return { perDone };
  }

  private status(perDelivered: number, perBilled: number): string {
    const delivered = perDelivered >= 99.99;
    const billed = perBilled >= 99.99;
    if (delivered && billed) return "Completed";
    if (billed) return "To Deliver";
    if (delivered) return "To Bill";
    return "To Deliver and Bill";
  }
}
