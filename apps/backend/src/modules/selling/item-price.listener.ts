import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Item Price auto-fill. On save of a billing transaction, any line left without a
 * rate is priced from the current Item Price for the relevant price list —
 * Standard Selling for customer documents, Standard Buying for supplier ones. A
 * line that already carries a rate is never overwritten, so manual overrides and
 * downstream pricing-rule discounts win. Registered before the PricingRuleListener
 * so the base price is set first. Pure event-bus listener — no cross-module imports.
 */
@Injectable()
export class ItemPriceListener {
  private readonly logger = new Logger(ItemPriceListener.name);
  private static readonly SELLING = new Set(["Quotation", "Sales Order", "Sales Invoice"]);
  private static readonly BUYING = new Set(["Purchase Order", "Purchase Invoice"]);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save")
  async onBeforeSave(payload: BeforeSavePayload): Promise<void> {
    if (!this.registry.has("Item Price")) return;
    const dt = String(payload.doctype ?? "");
    const priceList = ItemPriceListener.SELLING.has(dt)
      ? "Standard Selling"
      : ItemPriceListener.BUYING.has(dt)
        ? "Standard Buying"
        : null;
    if (!priceList) return;
    const items = payload.data.items as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(items) || items.length === 0) return;

    const today = new Date().toISOString().slice(0, 10);
    for (const row of items) {
      const item = String(row?.item_code ?? "");
      if (!item) continue;
      const rate = Number(row.rate ?? 0);
      if (rate > 0) continue; // keep an explicit / already-priced rate
      const price = await this.priceOf(item, priceList, today);
      if (price !== undefined) {
        row.rate = price;
        this.logger.log(`${dt}: priced ${item} at ${price} from ${priceList}`);
      }
    }
  }

  /** Latest Item Price for an item on a price list effective on/before `asOf`. */
  private async priceOf(item: string, priceList: string, asOf: string): Promise<number | undefined> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("rate")} AS rate FROM ${quoteIdent(tableNameFor("Item Price"))}
         WHERE ${quoteIdent("item_code")} = $1 AND ${quoteIdent("price_list")} = $2
           AND (${quoteIdent("valid_from")} IS NULL OR ${quoteIdent("valid_from")} <= $3)
         ORDER BY ${quoteIdent("valid_from")} DESC NULLS LAST, ${quoteIdent("name")} DESC
         LIMIT 1`,
        [item, priceList, asOf],
      )
    )[0];
    return row ? Number(row.rate) : undefined;
  }
}
