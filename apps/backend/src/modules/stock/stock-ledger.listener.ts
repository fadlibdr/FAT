import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

interface Movement {
  item: string;
  warehouse: string;
  delta: number; // +receipt / -issue
  incomingRate?: number; // valuation rate for receipts
}

/**
 * Maintains the stock ledger and item valuation (moving average).
 *
 * Reacts to Stock Entry, Delivery Note (issue) and Purchase Receipt (receipt)
 * submissions via the event bus — Stock imports no other module. Each movement
 * writes a Stock Ledger Entry (with the valuation rate used) and upserts the
 * per-item-per-warehouse Bin balance. Cancel reverses both.
 */
@Injectable()
export class StockLedgerListener {
  private readonly logger = new Logger(StockLedgerListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async itemRate(item: string): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("standard_rate")} AS r FROM ${quoteIdent(tableNameFor("Item"))}
       WHERE ${quoteIdent("name")} = $1`,
      [item],
    );
    return Number(rows[0]?.r ?? 0);
  }

  private async post(
    ctx: UserContext,
    m: Movement,
    voucherType: string,
    voucherNo: string,
    postingDate: unknown,
  ): Promise<void> {
    const sle = this.registry.get("Stock Ledger Entry");
    if (!sle || !m.warehouse) return;
    const binKey = `${m.item}::${m.warehouse}`;

    const bin = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("actual_qty")} AS qty, ${quoteIdent("valuation_rate")} AS rate,
                ${quoteIdent("stock_value")} AS value FROM ${quoteIdent(tableNameFor("Bin"))}
         WHERE ${quoteIdent("name")} = $1`,
        [binKey],
      )
    )[0];
    const qty0 = Number(bin?.qty ?? 0);
    const rate0 = Number(bin?.rate ?? 0);
    const value0 = Number(bin?.value ?? 0);

    const rateUsed = m.delta > 0 ? (m.incomingRate ?? rate0) : rate0;
    const deltaValue = m.delta * rateUsed;
    const newQty = qty0 + m.delta;
    const newValue = value0 + deltaValue;
    const newRate = m.delta > 0 && newQty > 0 ? newValue / newQty : rate0 || rateUsed;

    await this.documents.create(sle, ctx, {
      posting_date: postingDate ?? null,
      item_code: m.item,
      warehouse: m.warehouse,
      actual_qty: m.delta,
      valuation_rate: rateUsed,
      qty_after_transaction: newQty,
      stock_value: deltaValue,
      voucher_type: voucherType,
      voucher_no: voucherNo,
    });

    const now = new Date().toISOString();
    await this.dataSource.query(
      `INSERT INTO ${quoteIdent(tableNameFor("Bin"))}
        (${quoteIdent("name")}, ${quoteIdent("item_code")}, ${quoteIdent("warehouse")},
         ${quoteIdent("actual_qty")}, ${quoteIdent("valuation_rate")}, ${quoteIdent("stock_value")},
         ${quoteIdent("owner")}, ${quoteIdent("creation")}, ${quoteIdent("modified")},
         ${quoteIdent("modified_by")}, ${quoteIdent("docstatus")}, ${quoteIdent("idx")})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$7,0,0)
       ON CONFLICT (${quoteIdent("name")}) DO UPDATE SET
         ${quoteIdent("actual_qty")} = $4, ${quoteIdent("valuation_rate")} = $5,
         ${quoteIdent("stock_value")} = $6, ${quoteIdent("modified")} = $8`,
      [binKey, m.item, m.warehouse, newQty, newRate, newValue, ctx.name, now],
    );
  }

  private async reverse(voucherType: string, voucherNo: string): Promise<void> {
    if (!this.registry.has("Stock Ledger Entry") || !this.registry.has("Bin")) return;
    const sles = await this.dataSource.query(
      `SELECT ${quoteIdent("item_code")} AS item, ${quoteIdent("warehouse")} AS wh,
              ${quoteIdent("actual_qty")} AS qty, ${quoteIdent("stock_value")} AS value
       FROM ${quoteIdent(tableNameFor("Stock Ledger Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      [voucherType, voucherNo],
    );
    for (const s of sles) {
      const binKey = `${s.item}::${s.wh}`;
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Bin"))}
         SET ${quoteIdent("actual_qty")} = ${quoteIdent("actual_qty")} - $1,
             ${quoteIdent("stock_value")} = ${quoteIdent("stock_value")} - $2
         WHERE ${quoteIdent("name")} = $3`,
        [Number(s.qty), Number(s.value), binKey],
      );
    }
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("Stock Ledger Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      [voucherType, voucherNo],
    );
  }

  @OnEvent("doc.on_submit:Stock Entry")
  async onStockEntry(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const purpose = String(doc.purpose ?? "");
    const ctx = systemContext(payload.user);
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.qty ?? 0);
      if (!qty) continue;
      const item = String(row.item_code);
      const moves: Movement[] = [];
      if (purpose === "Material Receipt") {
        moves.push({ item, warehouse: String(row.t_warehouse ?? ""), delta: qty, incomingRate: await this.itemRate(item) });
      } else if (purpose === "Material Issue") {
        moves.push({ item, warehouse: String(row.s_warehouse ?? ""), delta: -qty });
      } else {
        if (row.s_warehouse) moves.push({ item, warehouse: String(row.s_warehouse), delta: -qty });
        if (row.t_warehouse) moves.push({ item, warehouse: String(row.t_warehouse), delta: qty, incomingRate: await this.itemRate(item) });
      }
      for (const m of moves) {
        try {
          await this.post(ctx, m, "Stock Entry", String(doc.name), doc.posting_date);
        } catch (err) {
          this.logger.error(`SLE ${doc.name}/${item}: ${(err as Error).message}`);
        }
      }
    }
    this.logger.log(`Posted stock ledger for Stock Entry ${doc.name}`);
  }

  @OnEvent("doc.on_submit:Delivery Note")
  async onDeliveryNote(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const ctx = systemContext(payload.user);
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.qty ?? 0);
      if (!qty || !row.warehouse) continue;
      try {
        await this.post(
          ctx,
          { item: String(row.item_code), warehouse: String(row.warehouse), delta: -qty },
          "Delivery Note",
          String(doc.name),
          doc.posting_date,
        );
      } catch (err) {
        this.logger.error(`SLE ${doc.name}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Posted stock ledger for Delivery Note ${doc.name}`);
  }

  @OnEvent("doc.on_submit:Purchase Receipt")
  async onPurchaseReceipt(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const ctx = systemContext(payload.user);
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.qty ?? 0);
      if (!qty || !row.warehouse) continue;
      try {
        await this.post(
          ctx,
          {
            item: String(row.item_code),
            warehouse: String(row.warehouse),
            delta: qty,
            incomingRate: Number(row.rate ?? 0) || (await this.itemRate(String(row.item_code))),
          },
          "Purchase Receipt",
          String(doc.name),
          doc.posting_date,
        );
      } catch (err) {
        this.logger.error(`SLE ${doc.name}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Posted stock ledger for Purchase Receipt ${doc.name}`);
  }

  @OnEvent("doc.on_cancel:Stock Entry")
  async cancelStockEntry(p: DocEventPayload): Promise<void> {
    await this.reverse("Stock Entry", String(p.doc.name));
  }

  @OnEvent("doc.on_cancel:Delivery Note")
  async cancelDeliveryNote(p: DocEventPayload): Promise<void> {
    await this.reverse("Delivery Note", String(p.doc.name));
  }

  @OnEvent("doc.on_cancel:Purchase Receipt")
  async cancelPurchaseReceipt(p: DocEventPayload): Promise<void> {
    await this.reverse("Purchase Receipt", String(p.doc.name));
  }
}
