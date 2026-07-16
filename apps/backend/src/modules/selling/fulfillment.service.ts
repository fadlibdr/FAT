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

  /**
   * Create a draft Sales Invoice billing a submitted Delivery Note. Copies the
   * delivered lines and carries the Delivery Note's own Sales Order link, so the
   * order's per_billed recomputes as usual; stamps the Delivery Note with the
   * invoice. Refuses a non-submitted delivery, a return, or one already billed.
   */
  async makeSalesInvoiceFromDelivery(dn: string, ctx?: UserContext): Promise<string> {
    const dnDt = this.registry.get("Delivery Note");
    const siDt = this.registry.get("Sales Invoice");
    if (!dnDt || !siDt) throw new BadRequestException("Delivery Note or Sales Invoice not registered");
    const context = ctx ?? systemContext();
    const note = await this.documents.get(dnDt, dn);
    if ((note.docstatus ?? 0) !== 1) throw new BadRequestException("Delivery Note must be submitted");
    if (Boolean(note.is_return)) throw new BadRequestException("Cannot bill a return Delivery Note");
    if (note.sales_invoice) throw new BadRequestException(`Delivery Note ${dn} already billed via ${note.sales_invoice}`);

    const items = ((note.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      rate: Number(r.rate ?? 0),
    }));
    const si = await this.documents.create(siDt, context, {
      customer: note.customer,
      posting_date: new Date().toISOString().slice(0, 10),
      sales_order: note.sales_order ?? null,
      delivery_note: dn,
      items,
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Delivery Note"))}
       SET ${quoteIdent("sales_invoice")} = $1 WHERE ${quoteIdent("name")} = $2`,
      [String(si.name), dn],
    );
    this.logger.log(`Delivery Note ${dn} -> Sales Invoice ${si.name}`);
    return String(si.name);
  }

  /**
   * Create a draft Credit Note (return Sales Invoice) against a submitted invoice:
   * mirrors the original lines at negative quantity and marks is_return with
   * return_against set. On submit the GL-posting listener reverses the original
   * posting (Dr Sales / Cr Debtors) and books a negative outstanding. Refuses a
   * non-submitted invoice or one that is itself a return.
   */
  async makeSalesReturn(si: string, ctx?: UserContext): Promise<string> {
    const siDt = this.registry.get("Sales Invoice");
    if (!siDt) throw new BadRequestException("Sales Invoice not registered");
    const context = ctx ?? systemContext();
    const inv = await this.documents.get(siDt, si);
    if ((inv.docstatus ?? 0) !== 1) throw new BadRequestException("Sales Invoice must be submitted");
    if (Boolean(inv.is_return)) throw new BadRequestException(`Sales Invoice ${si} is already a return`);

    const items = ((inv.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: -Math.abs(Number(r.qty ?? 0)),
      rate: Number(r.rate ?? 0),
    }));
    const credit = await this.documents.create(siDt, context, {
      customer: inv.customer,
      posting_date: new Date().toISOString().slice(0, 10),
      is_return: 1,
      return_against: si,
      sales_order: inv.sales_order ?? null,
      items,
    });
    this.logger.log(`Sales Invoice ${si} -> Credit Note ${credit.name}`);
    return String(credit.name);
  }

  /**
   * Create a draft return Delivery Note against a submitted delivery: mirrors the
   * shipped lines (same warehouses) and marks is_return with return_against set.
   * On submit the stock-ledger listener receives the goods back into stock at the
   * current valuation. Refuses a non-submitted delivery or one already a return.
   */
  async makeDeliveryReturn(dn: string, ctx?: UserContext): Promise<string> {
    const dnDt = this.registry.get("Delivery Note");
    if (!dnDt) throw new BadRequestException("Delivery Note not registered");
    const context = ctx ?? systemContext();
    const note = await this.documents.get(dnDt, dn);
    if ((note.docstatus ?? 0) !== 1) throw new BadRequestException("Delivery Note must be submitted");
    if (Boolean(note.is_return)) throw new BadRequestException(`Delivery Note ${dn} is already a return`);

    const items = ((note.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Math.abs(Number(r.qty ?? 0)),
      rate: Number(r.rate ?? 0),
      warehouse: r.warehouse,
    }));
    const ret = await this.documents.create(dnDt, context, {
      customer: note.customer,
      posting_date: new Date().toISOString().slice(0, 10),
      is_return: 1,
      return_against: dn,
      sales_order: note.sales_order ?? null,
      items,
    });
    this.logger.log(`Delivery Note ${dn} -> return Delivery Note ${ret.name}`);
    return String(ret.name);
  }

  /** Create a draft Sales Order from a submitted Quotation, linking both. */
  async makeSalesOrder(quotation: string, ctx?: UserContext): Promise<string> {
    const qtnDt = this.registry.get("Quotation");
    const soDt = this.registry.get("Sales Order");
    if (!qtnDt || !soDt) throw new BadRequestException("Quotation or Sales Order not registered");
    const context = ctx ?? systemContext();
    const qtn = await this.documents.get(qtnDt, quotation);
    if ((qtn.docstatus ?? 0) !== 1) throw new BadRequestException("Quotation must be submitted");
    if (qtn.sales_order) throw new BadRequestException(`Quotation ${quotation} already ordered (${qtn.sales_order})`);
    const validTill = this.isoDay(qtn.valid_till);
    const asOf = new Date().toISOString().slice(0, 10);
    if (String(qtn.status) === "Expired" || (validTill && validTill < asOf)) {
      throw new BadRequestException(
        `Quotation ${quotation} has expired${validTill ? ` (valid till ${validTill})` : ""} and cannot be converted`,
      );
    }

    const items = ((qtn.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      rate: Number(r.rate ?? 0),
    }));
    const today = new Date().toISOString().slice(0, 10);
    const so = await this.documents.create(soDt, context, {
      customer: qtn.customer,
      transaction_date: today,
      delivery_date: (qtn.valid_till as string) ?? today,
      quotation,
      items,
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Quotation"))}
       SET ${quoteIdent("sales_order")} = $1, ${quoteIdent("status")} = 'Ordered'
       WHERE ${quoteIdent("name")} = $2`,
      [String(so.name), quotation],
    );
    this.logger.log(`Quotation ${quotation} -> Sales Order ${so.name}`);
    return String(so.name);
  }

  /** Normalize a date value (string or JS Date) to YYYY-MM-DD. */
  private isoDay(value: unknown): string {
    if (!value) return "";
    if (value instanceof Date) {
      const y = value.getUTCFullYear();
      const m = String(value.getUTCMonth() + 1).padStart(2, "0");
      const d = String(value.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
  }

  /**
   * Expire quotations whose validity has lapsed: any submitted, not-yet-ordered
   * quotation with a `valid_till` before the as-of date is marked Expired, dropping
   * it from the live pipeline and barring its conversion to a Sales Order.
   */
  async expireQuotations(asOf?: string): Promise<{ expired: string[] }> {
    if (!this.registry.has("Quotation")) return { expired: [] };
    const asOfDay = asOf ? String(asOf).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const table = quoteIdent(tableNameFor("Quotation"));
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name FROM ${table}
       WHERE ${quoteIdent("docstatus")} = 1
         AND coalesce(${quoteIdent("status")}, '') NOT IN ('Ordered', 'Expired')
         AND ${quoteIdent("sales_order")} IS NULL
         AND ${quoteIdent("valid_till")} IS NOT NULL
         AND ${quoteIdent("valid_till")}::date < $1::date`,
      [asOfDay],
    );
    const names = (rows as Array<{ name: string }>).map((r) => String(r.name));
    if (names.length > 0) {
      await this.dataSource.query(
        `UPDATE ${table} SET ${quoteIdent("status")} = 'Expired' WHERE ${quoteIdent("name")} = ANY($1)`,
        [names],
      );
    }
    this.logger.log(`Quotation expiry: ${names.length} expired as of ${asOfDay}`);
    return { expired: names };
  }

  async recomputeSalesOrder(so: string): Promise<void> {
    if (!this.registry.has("Sales Order") || !so) return;
    // A short-closed order is finalized: its remaining quantity is written off, so
    // a later delivery/invoice must not silently reopen it.
    const closed = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("is_closed")} AS c FROM ${quoteIdent(tableNameFor("Sales Order"))}
         WHERE ${quoteIdent("name")} = $1`,
        [so],
      )
    )[0];
    if (Number(closed?.c ?? 0) === 1) return;
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
   * Short-close a Sales Order: stop expecting the un-delivered / un-billed balance
   * and mark it Closed so it drops out of the open-order pipeline. Only a
   * submitted order that is not already Completed or Closed can be short-closed.
   */
  async closeSalesOrder(so: string): Promise<{ order: string; status: string }> {
    if (!this.registry.has("Sales Order")) throw new BadRequestException("Sales Order not registered");
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("docstatus")} AS docstatus, ${quoteIdent("status")} AS status,
                ${quoteIdent("is_closed")} AS is_closed
         FROM ${quoteIdent(tableNameFor("Sales Order"))} WHERE ${quoteIdent("name")} = $1`,
        [so],
      )
    )[0];
    if (!row) throw new BadRequestException(`Sales Order ${so} not found`);
    if (Number(row.docstatus ?? 0) !== 1) throw new BadRequestException(`Sales Order ${so} must be submitted to close`);
    if (Number(row.is_closed ?? 0) === 1) throw new BadRequestException(`Sales Order ${so} is already closed`);
    if (String(row.status) === "Completed") throw new BadRequestException(`Sales Order ${so} is already Completed`);
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Sales Order"))}
       SET ${quoteIdent("is_closed")} = 1, ${quoteIdent("status")} = 'Closed' WHERE ${quoteIdent("name")} = $1`,
      [so],
    );
    this.logger.log(`Sales Order ${so} short-closed`);
    return { order: so, status: "Closed" };
  }

  /** Reopen a short-closed order and recompute its status from its documents. */
  async reopenSalesOrder(so: string): Promise<{ order: string; status: string }> {
    if (!this.registry.has("Sales Order")) throw new BadRequestException("Sales Order not registered");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Sales Order"))} SET ${quoteIdent("is_closed")} = 0
       WHERE ${quoteIdent("name")} = $1`,
      [so],
    );
    await this.recomputeSalesOrder(so);
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("status")} AS status FROM ${quoteIdent(tableNameFor("Sales Order"))}
         WHERE ${quoteIdent("name")} = $1`,
        [so],
      )
    )[0];
    this.logger.log(`Sales Order ${so} reopened`);
    return { order: so, status: String(row?.status ?? "") };
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
