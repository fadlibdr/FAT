import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Sales team & agreements. Pure event-bus listener, no cross-module imports:
 *
 *  1. on_submit/on_cancel of a Sales Invoice accrues (and unwinds) the sales
 *     person's commission (base_grand_total × commission_rate%) and sales total.
 *  2. before_submit of a Sales Order gates it against its Blanket Order's
 *     remaining quantity; on_submit/on_cancel rolls the ordered qty on the
 *     blanket order.
 */
@Injectable()
export class SalesteamListener {
  private readonly logger = new Logger(SalesteamListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // ---- Commission ----------------------------------------------------------

  @OnEvent("doc.on_submit:Sales Invoice")
  async onInvoiceSubmit(payload: DocEventPayload): Promise<void> {
    await this.accrueCommission(payload.doc, 1);
  }

  @OnEvent("doc.on_cancel:Sales Invoice")
  async onInvoiceCancel(payload: DocEventPayload): Promise<void> {
    await this.accrueCommission(payload.doc, -1);
  }

  private async accrueCommission(doc: Record<string, unknown>, sign: 1 | -1): Promise<void> {
    if (!this.registry.has("Sales Person")) return;
    const person = String(doc.sales_person ?? "");
    if (!person || Boolean(doc.is_return)) return;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("commission_rate")} AS rate FROM ${quoteIdent(tableNameFor("Sales Person"))}
         WHERE ${quoteIdent("name")} = $1`,
        [person],
      )
    )[0];
    if (!row) return;
    const sales = Number(doc.base_grand_total ?? doc.grand_total ?? 0);
    const commission = Math.round((sales * Number(row.rate ?? 0)) / 100 * 100 + Number.EPSILON) / 100;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Sales Person"))}
       SET ${quoteIdent("total_sales")} = coalesce(${quoteIdent("total_sales")}, 0) + $1,
           ${quoteIdent("total_commission")} = coalesce(${quoteIdent("total_commission")}, 0) + $2
       WHERE ${quoteIdent("name")} = $3`,
      [sign * sales, sign * commission, person],
    );
    this.logger.log(
      `Sales Person ${person}: ${sign > 0 ? "accrued" : "reversed"} sales ${sales} / commission ${commission}`,
    );
  }

  // ---- Blanket Order -------------------------------------------------------

  private orderedQtyFor(doc: Record<string, unknown>, item: string): number {
    const items = (doc.items as Array<Record<string, unknown>>) ?? [];
    return items
      .filter((r) => String(r.item_code ?? "") === item)
      .reduce((s, r) => s + Number(r.qty ?? 0), 0);
  }

  private async blanket(name: string): Promise<{ item: string; total: number; ordered: number } | undefined> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("item_code")} AS item, ${quoteIdent("total_qty")} AS total,
                ${quoteIdent("ordered_qty")} AS ordered
         FROM ${quoteIdent(tableNameFor("Blanket Order"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    return row ? { item: String(row.item), total: Number(row.total ?? 0), ordered: Number(row.ordered ?? 0) } : undefined;
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Sales Order", { suppressErrors: false })
  async gateSalesOrder(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const bo = String(doc.blanket_order ?? "");
    if (!bo || !this.registry.has("Blanket Order")) return;
    const b = await this.blanket(bo);
    if (!b) return;
    const thisQty = this.orderedQtyFor(doc, b.item);
    if (b.ordered + thisQty > b.total + 1e-9) {
      throw new BadRequestException(
        `Sales Order ${doc.name}: ordering ${thisQty} of ${b.item} exceeds Blanket Order ${bo} remaining ` +
          `${b.total - b.ordered} (total ${b.total}, already ${b.ordered})`,
      );
    }
  }

  @OnEvent("doc.on_submit:Sales Order")
  async onOrderSubmit(payload: DocEventPayload): Promise<void> {
    await this.rollBlanket(payload.doc, 1);
  }

  @OnEvent("doc.on_cancel:Sales Order")
  async onOrderCancel(payload: DocEventPayload): Promise<void> {
    await this.rollBlanket(payload.doc, -1);
  }

  private async rollBlanket(doc: Record<string, unknown>, sign: 1 | -1): Promise<void> {
    const bo = String(doc.blanket_order ?? "");
    if (!bo || !this.registry.has("Blanket Order")) return;
    const b = await this.blanket(bo);
    if (!b) return;
    const thisQty = this.orderedQtyFor(doc, b.item);
    const ordered = Math.max(0, b.ordered + sign * thisQty);
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Blanket Order"))}
       SET ${quoteIdent("ordered_qty")} = $1,
           ${quoteIdent("status")} = $2
       WHERE ${quoteIdent("name")} = $3`,
      [ordered, ordered >= b.total - 1e-9 ? "Completed" : "Active", bo],
    );
    this.logger.log(`Blanket Order ${bo}: ordered_qty -> ${ordered}/${b.total}`);
  }
}
