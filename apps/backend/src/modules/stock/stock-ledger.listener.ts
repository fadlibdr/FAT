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
  batch?: string | null;
  serials?: string[];
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

  private async itemMethod(item: string): Promise<string> {
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("valuation_method")} AS m FROM ${quoteIdent(tableNameFor("Item"))}
       WHERE ${quoteIdent("name")} = $1`,
      [item],
    );
    return rows[0]?.m ?? "Moving Average";
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
    // Bin is keyed per item+warehouse+batch, so each batch is valued separately.
    const batch = m.batch ?? "";
    const binKey = `${m.item}::${m.warehouse}::${batch}`;
    const method = await this.itemMethod(m.item);

    const bin = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("actual_qty")} AS qty, ${quoteIdent("valuation_rate")} AS rate,
                ${quoteIdent("stock_value")} AS value, ${quoteIdent("fifo_queue")} AS fifo
         FROM ${quoteIdent(tableNameFor("Bin"))} WHERE ${quoteIdent("name")} = $1`,
        [binKey],
      )
    )[0];
    const qty0 = Number(bin?.qty ?? 0);
    const rate0 = Number(bin?.rate ?? 0);
    const value0 = Number(bin?.value ?? 0);
    let layers: Array<{ qty: number; rate: number }> = [];
    try {
      layers = bin?.fifo ? JSON.parse(bin.fifo) : [];
    } catch {
      layers = [];
    }

    let rateUsed: number;
    let newValue: number;
    let newLayers = layers.map((l) => ({ ...l }));

    if (method === "FIFO") {
      if (m.delta > 0) {
        rateUsed = m.incomingRate ?? rate0 ?? 0;
        newLayers.push({ qty: m.delta, rate: rateUsed });
      } else {
        let toConsume = -m.delta;
        let consumedValue = 0;
        let consumedQty = 0;
        while (toConsume > 1e-9 && newLayers.length) {
          const layer = newLayers[0];
          const take = Math.min(layer.qty, toConsume);
          consumedValue += take * layer.rate;
          consumedQty += take;
          layer.qty -= take;
          toConsume -= take;
          if (layer.qty <= 1e-9) newLayers.shift();
        }
        rateUsed = consumedQty ? consumedValue / consumedQty : rate0;
      }
      newValue = newLayers.reduce((s, l) => s + l.qty * l.rate, 0);
    } else {
      rateUsed = m.delta > 0 ? (m.incomingRate ?? rate0) : rate0;
      newValue = value0 + m.delta * rateUsed;
      newLayers = [];
    }

    const deltaValue = m.delta * rateUsed;
    const newQty = qty0 + m.delta;
    const newRate = newQty > 0 ? newValue / newQty : rate0 || rateUsed;

    await this.documents.create(sle, ctx, {
      posting_date: postingDate ?? null,
      item_code: m.item,
      warehouse: m.warehouse,
      actual_qty: m.delta,
      valuation_rate: rateUsed,
      qty_after_transaction: newQty,
      stock_value: deltaValue,
      batch_no: m.batch ?? null,
      serial_no: (m.serials ?? []).join("\n") || null,
      voucher_type: voucherType,
      voucher_no: voucherNo,
    });

    const now = new Date().toISOString();
    await this.dataSource.query(
      `INSERT INTO ${quoteIdent(tableNameFor("Bin"))}
        (${quoteIdent("name")}, ${quoteIdent("item_code")}, ${quoteIdent("warehouse")},
         ${quoteIdent("batch_no")}, ${quoteIdent("actual_qty")}, ${quoteIdent("valuation_rate")},
         ${quoteIdent("stock_value")}, ${quoteIdent("fifo_queue")}, ${quoteIdent("owner")},
         ${quoteIdent("creation")}, ${quoteIdent("modified")}, ${quoteIdent("modified_by")},
         ${quoteIdent("docstatus")}, ${quoteIdent("idx")})
       VALUES ($1,$2,$3,$10,$4,$5,$6,$7,$8,$9,$9,$8,0,0)
       ON CONFLICT (${quoteIdent("name")}) DO UPDATE SET
         ${quoteIdent("actual_qty")} = $4, ${quoteIdent("valuation_rate")} = $5,
         ${quoteIdent("stock_value")} = $6, ${quoteIdent("fifo_queue")} = $7, ${quoteIdent("modified")} = $9`,
      [binKey, m.item, m.warehouse, newQty, newRate, newValue, JSON.stringify(newLayers), ctx.name, now, batch || null],
    );

    await this.handleSerials(m, voucherNo);
  }

  /** Create serial records on receipt; mark them delivered on issue. */
  private async handleSerials(m: Movement, voucherNo: string): Promise<void> {
    const serials = m.serials ?? [];
    if (serials.length === 0 || !this.registry.has("Serial No")) return;
    const now = new Date().toISOString();
    for (const sn of serials) {
      if (m.delta > 0) {
        await this.dataSource.query(
          `INSERT INTO ${quoteIdent(tableNameFor("Serial No"))}
            (${quoteIdent("name")}, ${quoteIdent("serial_no")}, ${quoteIdent("item")},
             ${quoteIdent("warehouse")}, ${quoteIdent("status")}, ${quoteIdent("voucher_no")},
             ${quoteIdent("owner")}, ${quoteIdent("creation")}, ${quoteIdent("modified")},
             ${quoteIdent("modified_by")}, ${quoteIdent("docstatus")}, ${quoteIdent("idx")})
           VALUES ($1,$1,$2,$3,'Active',$4,'Administrator',$5,$5,'Administrator',0,0)
           ON CONFLICT (${quoteIdent("name")}) DO UPDATE SET
             ${quoteIdent("status")} = 'Active', ${quoteIdent("warehouse")} = $3,
             ${quoteIdent("modified")} = $5`,
          [sn, m.item, m.warehouse, voucherNo, now],
        );
      } else {
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Serial No"))}
           SET ${quoteIdent("status")} = 'Delivered', ${quoteIdent("modified")} = $2
           WHERE ${quoteIdent("name")} = $1`,
          [sn, now],
        );
      }
    }
  }

  private async reverse(voucherType: string, voucherNo: string): Promise<void> {
    if (!this.registry.has("Stock Ledger Entry") || !this.registry.has("Bin")) return;
    const sles = await this.dataSource.query(
      `SELECT ${quoteIdent("item_code")} AS item, ${quoteIdent("warehouse")} AS wh,
              ${quoteIdent("batch_no")} AS batch,
              ${quoteIdent("actual_qty")} AS qty, ${quoteIdent("stock_value")} AS value
       FROM ${quoteIdent(tableNameFor("Stock Ledger Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      [voucherType, voucherNo],
    );
    for (const s of sles) {
      const binKey = `${s.item}::${s.wh}::${s.batch ?? ""}`;
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
      const batch = (row.batch_no as string) || null;
      const serials = String(row.serial_no ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      // Explicit valuation rate wins for receipts (e.g. a manufactured FG whose
      // cost is rolled up from its consumed raw materials); else item standard.
      const rcvRate = row.basic_rate != null && row.basic_rate !== ""
        ? Number(row.basic_rate)
        : await this.itemRate(item);
      const moves: Movement[] = [];
      if (purpose === "Material Receipt") {
        moves.push({ item, warehouse: String(row.t_warehouse ?? ""), delta: qty, incomingRate: rcvRate, batch, serials });
      } else if (purpose === "Material Issue") {
        moves.push({ item, warehouse: String(row.s_warehouse ?? ""), delta: -qty, batch, serials });
      } else {
        if (row.s_warehouse) moves.push({ item, warehouse: String(row.s_warehouse), delta: -qty, batch, serials });
        if (row.t_warehouse) moves.push({ item, warehouse: String(row.t_warehouse), delta: qty, incomingRate: rcvRate, batch, serials });
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

  /** Current Bin balance for an item+warehouse(+batch) — used by reconciliation. */
  private async binBalance(
    item: string,
    warehouse: string,
    batch: string,
  ): Promise<{ qty: number; rate: number }> {
    const bin = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("actual_qty")} AS qty, ${quoteIdent("valuation_rate")} AS rate
         FROM ${quoteIdent(tableNameFor("Bin"))} WHERE ${quoteIdent("name")} = $1`,
        [`${item}::${warehouse}::${batch}`],
      )
    )[0];
    return { qty: Number(bin?.qty ?? 0), rate: Number(bin?.rate ?? 0) };
  }

  /**
   * A submitted Stock Reconciliation asserts an absolute counted quantity per
   * item+warehouse. We read the current Bin balance, post a Stock Ledger Entry
   * for the *difference* (which drives the Bin to the counted qty via the shared
   * moving-average/FIFO posting), and stamp each row's current/difference qty and
   * the voucher's net valuation change. Cancel reverses the same delta.
   */
  @OnEvent("doc.on_submit:Stock Reconciliation")
  async onStockReconciliation(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const ctx = systemContext(payload.user);
    let differenceAmount = 0;
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      const warehouse = String(row.warehouse ?? "");
      if (!item || !warehouse) continue;
      const counted = Number(row.qty ?? 0);
      const { qty: currentQty, rate: currentRate } = await this.binBalance(item, warehouse, "");
      const delta = counted - currentQty;
      // An explicit valuation rate overrides the current one (e.g. Opening Stock).
      const rate = row.valuation_rate != null && row.valuation_rate !== ""
        ? Number(row.valuation_rate)
        : currentRate;
      try {
        if (delta !== 0) {
          await this.post(
            ctx,
            { item, warehouse, delta, incomingRate: delta > 0 ? rate : undefined },
            "Stock Reconciliation",
            String(doc.name),
            doc.posting_date,
          );
        }
        differenceAmount += delta * (rate || currentRate);
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Stock Reconciliation Item"))}
           SET ${quoteIdent("current_qty")} = $1, ${quoteIdent("difference_qty")} = $2
           WHERE ${quoteIdent("name")} = $3`,
          [currentQty, delta, String(row.name)],
        );
      } catch (err) {
        this.logger.error(`Reconcile ${doc.name}/${item}: ${(err as Error).message}`);
      }
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Stock Reconciliation"))}
       SET ${quoteIdent("difference_amount")} = $1 WHERE ${quoteIdent("name")} = $2`,
      [differenceAmount, String(doc.name)],
    );
    this.logger.log(`Reconciled stock for ${doc.name} (net value ${differenceAmount})`);
  }

  @OnEvent("doc.on_cancel:Stock Reconciliation")
  async cancelStockReconciliation(p: DocEventPayload): Promise<void> {
    await this.reverse("Stock Reconciliation", String(p.doc.name));
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
