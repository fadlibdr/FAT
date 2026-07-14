import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const COGS = "Cost of Goods Sold";
const STOCK_IN_HAND = "Stock In Hand";
const SRBNB = "Stock Received But Not Billed";

/** Round to 2 decimals. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Perpetual inventory GL. Keeps the Stock In Hand asset account in step with the
 * physical stock ledger by booking the accounting side of each stock movement:
 *
 *  - Purchase Receipt: Dr Stock In Hand / Cr Stock Received But Not Billed at the
 *    received value (qty × rate).
 *  - Delivery Note (issue): Dr Cost of Goods Sold / Cr Stock In Hand at the
 *    delivered items' current valuation; a sales return reverses the sign.
 *
 * Reads stock data (Bin valuation, Stock Ledger Entry) via SQL only — no
 * cross-module service imports. Cancel deletes the voucher's GL.
 */
@Injectable()
export class InventoryGlListener {
  private readonly logger = new Logger(InventoryGlListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Purchase Receipt")
  async onPurchaseReceipt(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (!this.registry.get("GL Entry")) return;
    let value = 0;
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.qty ?? 0);
      const rate = Number(row.rate ?? 0) || (await this.itemRate(String(row.item_code)));
      value += qty * rate;
    }
    value = round2(value);
    if (value <= 0) return;
    await this.postPair(payload, "Purchase Receipt", STOCK_IN_HAND, SRBNB, value, String(doc.supplier ?? ""));
    this.logger.log(`Purchase Receipt ${doc.name}: Dr ${STOCK_IN_HAND} / Cr ${SRBNB} ${value}`);
  }

  @OnEvent("doc.on_submit:Delivery Note")
  async onDeliveryNote(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (!this.registry.get("GL Entry")) return;
    const isReturn = Boolean(doc.is_return);
    let cogs = 0;
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.qty ?? 0);
      if (!qty || !row.warehouse) continue;
      const rate = await this.valuationRate(String(row.item_code), String(row.warehouse));
      cogs += qty * rate;
    }
    cogs = round2(cogs);
    if (cogs <= 0) return;
    // Normal issue: Dr COGS / Cr Stock In Hand. A return brings goods back in.
    if (isReturn) {
      await this.postPair(payload, "Delivery Note", STOCK_IN_HAND, COGS, cogs, String(doc.customer ?? ""));
    } else {
      await this.postPair(payload, "Delivery Note", COGS, STOCK_IN_HAND, cogs, String(doc.customer ?? ""));
    }
    this.logger.log(`Delivery Note ${doc.name}: COGS ${cogs}${isReturn ? " (return)" : ""}`);
  }

  @OnEvent("doc.on_cancel:Delivery Note")
  async onDeliveryCancel(payload: DocEventPayload): Promise<void> {
    await this.reverse("Delivery Note", payload.doc.name);
  }

  @OnEvent("doc.on_cancel:Purchase Receipt")
  async onReceiptCancel(payload: DocEventPayload): Promise<void> {
    await this.reverse("Purchase Receipt", payload.doc.name);
  }

  /**
   * Current valuation rate for an item+warehouse. Reads the Bin moving-average
   * rate; if the Bin has been drawn down to zero (rate reset), falls back to the
   * most recent stock-ledger rate so the COGS is still valued correctly.
   */
  private async valuationRate(item: string, warehouse: string): Promise<number> {
    if (this.registry.has("Bin")) {
      const bin = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("valuation_rate")} AS rate
           FROM ${quoteIdent(tableNameFor("Bin"))}
           WHERE ${quoteIdent("item_code")} = $1 AND ${quoteIdent("warehouse")} = $2
           ORDER BY ${quoteIdent("valuation_rate")} DESC LIMIT 1`,
          [item, warehouse],
        )
      )[0];
      const rate = Number(bin?.rate ?? 0);
      if (rate > 0) return rate;
    }
    if (this.registry.has("Stock Ledger Entry")) {
      const sle = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("valuation_rate")} AS rate
           FROM ${quoteIdent(tableNameFor("Stock Ledger Entry"))}
           WHERE ${quoteIdent("item_code")} = $1 AND ${quoteIdent("warehouse")} = $2
             AND coalesce(${quoteIdent("valuation_rate")}, 0) > 0
           ORDER BY ${quoteIdent("creation")} DESC LIMIT 1`,
          [item, warehouse],
        )
      )[0];
      return Number(sle?.rate ?? 0);
    }
    return 0;
  }

  private async itemRate(item: string): Promise<number> {
    if (!this.registry.has("Item")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("standard_rate")} AS rate
         FROM ${quoteIdent(tableNameFor("Item"))} WHERE ${quoteIdent("name")} = $1`,
        [item],
      )
    )[0];
    return Number(row?.rate ?? 0);
  }

  private async postPair(
    payload: DocEventPayload,
    voucherType: string,
    debitAccount: string,
    creditAccount: string,
    amount: number,
    against: string,
  ): Promise<void> {
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const doc = payload.doc;
    try {
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: voucherType, voucher_no: String(doc.name),
        account: debitAccount, debit: amount, credit: 0, against,
      });
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: voucherType, voucher_no: String(doc.name),
        account: creditAccount, debit: 0, credit: amount, against,
      });
    } catch (err) {
      this.logger.error(`${voucherType} ${doc.name} inventory GL failed: ${(err as Error).message}`);
    }
  }

  private async reverse(voucherType: string, voucherNo: unknown): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      [voucherType, String(voucherNo)],
    );
  }
}
