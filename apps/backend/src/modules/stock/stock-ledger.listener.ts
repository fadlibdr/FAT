import { BadRequestException, Injectable, Logger } from "@nestjs/common";
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

  /**
   * If `item` is the parent of a Product Bundle (a sales kit), return its
   * component items and per-bundle quantities; otherwise null. A bundle parent is
   * non-stock — deliveries issue its components, not the parent itself.
   */
  async bundleComponents(item: string): Promise<Array<{ item: string; qty: number }> | null> {
    if (!this.registry.has("Product Bundle") || !this.registry.has("Product Bundle Item")) return null;
    const rows = await this.dataSource.query(
      `SELECT pbi.${quoteIdent("item_code")} AS item, pbi.${quoteIdent("qty")} AS qty
       FROM ${quoteIdent(tableNameFor("Product Bundle Item"))} pbi
       JOIN ${quoteIdent(tableNameFor("Product Bundle"))} pb ON pb.${quoteIdent("name")} = pbi.${quoteIdent("parent")}
       WHERE pb.${quoteIdent("new_item_code")} = $1`,
      [item],
    );
    return rows.length ? rows.map((r: { item: string; qty: unknown }) => ({ item: String(r.item), qty: Number(r.qty ?? 0) })) : null;
  }

  @OnEvent("doc.on_submit:Delivery Note")
  async onDeliveryNote(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const ctx = systemContext(payload.user);
    // A sales return (is_return) receives goods back into stock at the current
    // valuation instead of issuing them out.
    const isReturn = Boolean(doc.is_return);
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.qty ?? 0);
      if (!qty || !row.warehouse) continue;
      const warehouse = String(row.warehouse);
      // A Product Bundle line issues its components (qty × line qty), not the
      // non-stock parent item.
      const components = await this.bundleComponents(String(row.item_code));
      if (components) {
        for (const c of components) {
          try {
            await this.post(
              ctx,
              { item: c.item, warehouse, delta: isReturn ? c.qty * qty : -(c.qty * qty) },
              "Delivery Note",
              String(doc.name),
              doc.posting_date,
            );
          } catch (err) {
            this.logger.error(`SLE ${doc.name} (bundle ${row.item_code}): ${(err as Error).message}`);
          }
        }
        continue;
      }
      const serials = String(row.serial_no ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      const batch = (row.batch_no as string) || null;
      try {
        await this.post(
          ctx,
          { item: String(row.item_code), warehouse, delta: isReturn ? qty : -qty, batch, serials },
          "Delivery Note",
          String(doc.name),
          doc.posting_date,
        );
      } catch (err) {
        this.logger.error(`SLE ${doc.name}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Posted stock ledger for Delivery Note ${doc.name}${isReturn ? " (return)" : ""}`);
  }

  /**
   * Before a (non-return) Delivery Note is submitted, verify each listed serial
   * number is a known, Active unit sitting in the line's warehouse — so an unknown,
   * already-delivered, or wrong-warehouse serial can't ship. suppressErrors:false so
   * the throw aborts the submit.
   */
  /**
   * Before a (non-return) Delivery Note is submitted, block any line whose batch has
   * expired on or before the posting date, so expired stock can't ship.
   */
  /**
   * Normalize a date value to a YYYY-MM-DD string. TypeORM returns `date` columns
   * as JS Date objects and the in-memory payload may already carry a Date, so a
   * naive String(value).slice(0,10) yields weekday-prefixed text ("Thu Dec 31")
   * whose lexicographic order is meaningless. Format explicitly instead.
   */
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

  @OnEvent("doc.before_submit:Delivery Note", { suppressErrors: false })
  async gateDeliveryBatchExpiry(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (Boolean(doc.is_return) || !this.registry.has("Batch")) return;
    const asOf = doc.posting_date ? this.isoDay(doc.posting_date) : new Date().toISOString().slice(0, 10);
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const batch = String(row.batch_no ?? "");
      if (!batch) continue;
      const rec = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("expiry_date")} AS expiry FROM ${quoteIdent(tableNameFor("Batch"))}
           WHERE ${quoteIdent("name")} = $1`,
          [batch],
        )
      )[0];
      const expiry = this.isoDay(rec?.expiry);
      if (expiry && expiry <= asOf) {
        throw new BadRequestException(
          `Delivery Note ${doc.name}: batch ${batch} expired ${expiry} (on or before ${asOf})`,
        );
      }
    }
  }

  /**
   * If the batch has an expiry_date on or before `asOf`, return that expiry
   * (YYYY-MM-DD); otherwise "". Empty batch or no expiry never expires.
   */
  private async batchExpiredOnOrBefore(batch: string, asOf: string): Promise<string> {
    if (!batch || !this.registry.has("Batch")) return "";
    const rec = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("expiry_date")} AS expiry FROM ${quoteIdent(tableNameFor("Batch"))}
         WHERE ${quoteIdent("name")} = $1`,
        [batch],
      )
    )[0];
    const expiry = this.isoDay(rec?.expiry);
    return expiry && expiry <= asOf ? expiry : "";
  }

  /**
   * Before a (non-return) Purchase Receipt is submitted, block receiving any line
   * whose batch has already expired on or before the posting date — expired stock
   * must not enter inventory.
   */
  @OnEvent("doc.before_submit:Purchase Receipt", { suppressErrors: false })
  async gateReceiptBatchExpiry(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (Boolean(doc.is_return) || !this.registry.has("Batch")) return;
    const asOf = doc.posting_date ? this.isoDay(doc.posting_date) : new Date().toISOString().slice(0, 10);
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const batch = String(row.batch_no ?? "");
      const expiry = await this.batchExpiredOnOrBefore(batch, asOf);
      if (expiry) {
        throw new BadRequestException(
          `Purchase Receipt ${doc.name}: cannot receive batch ${batch} — expired ${expiry} (on or before ${asOf})`,
        );
      }
    }
  }

  /**
   * Before a Stock Entry is submitted, block any incoming line (one that lands in
   * a target warehouse) whose batch has already expired on or before the posting
   * date — the receipt half of a material receipt/transfer must not book expired
   * stock into inventory.
   */
  @OnEvent("doc.before_submit:Stock Entry", { suppressErrors: false })
  async gateStockEntryBatchExpiry(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (!this.registry.has("Batch")) return;
    const asOf = doc.posting_date ? this.isoDay(doc.posting_date) : new Date().toISOString().slice(0, 10);
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      if (!row.t_warehouse) continue; // only the incoming (received) leg
      const batch = String(row.batch_no ?? "");
      const expiry = await this.batchExpiredOnOrBefore(batch, asOf);
      if (expiry) {
        throw new BadRequestException(
          `Stock Entry ${doc.name}: cannot receive batch ${batch} — expired ${expiry} (on or before ${asOf})`,
        );
      }
    }
  }

  @OnEvent("doc.before_submit:Delivery Note", { suppressErrors: false })
  async gateDeliverySerials(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (Boolean(doc.is_return) || !this.registry.has("Serial No")) return;
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const serials = String(row.serial_no ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (serials.length === 0) continue;
      const warehouse = String(row.warehouse ?? "");
      for (const sn of serials) {
        const rec = (
          await this.dataSource.query(
            `SELECT ${quoteIdent("status")} AS status, ${quoteIdent("warehouse")} AS warehouse
             FROM ${quoteIdent(tableNameFor("Serial No"))} WHERE ${quoteIdent("name")} = $1`,
            [sn],
          )
        )[0];
        if (!rec) {
          throw new BadRequestException(`Delivery Note ${doc.name}: serial ${sn} does not exist`);
        }
        if (String(rec.status) !== "Active") {
          throw new BadRequestException(`Delivery Note ${doc.name}: serial ${sn} is ${rec.status}, not Active`);
        }
        if (warehouse && String(rec.warehouse) !== warehouse) {
          throw new BadRequestException(
            `Delivery Note ${doc.name}: serial ${sn} is in ${rec.warehouse}, not ${warehouse}`,
          );
        }
      }
    }
  }

  @OnEvent("doc.on_submit:Purchase Receipt")
  async onPurchaseReceipt(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const ctx = systemContext(payload.user);
    // A purchase return (is_return) ships goods back to the supplier, so it issues
    // stock at the current valuation rather than receiving it.
    const isReturn = Boolean(doc.is_return);
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.qty ?? 0);
      if (!qty || !row.warehouse) continue;
      try {
        await this.post(
          ctx,
          {
            item: String(row.item_code),
            warehouse: String(row.warehouse),
            delta: isReturn ? -qty : qty,
            incomingRate: isReturn
              ? undefined
              : Number(row.rate ?? 0) || (await this.itemRate(String(row.item_code))),
            batch: (row.batch_no as string) || null,
          },
          "Purchase Receipt",
          String(doc.name),
          doc.posting_date,
        );
      } catch (err) {
        this.logger.error(`SLE ${doc.name}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Posted stock ledger for Purchase Receipt ${doc.name}${isReturn ? " (return)" : ""}`);
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

  /** Add a value delta to a Bin and recompute its per-unit valuation rate. */
  private async bumpBinValue(item: string, warehouse: string, deltaValue: number): Promise<void> {
    const binKey = `${item}::${warehouse}::`;
    const bin = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("actual_qty")} AS qty, ${quoteIdent("stock_value")} AS value
         FROM ${quoteIdent(tableNameFor("Bin"))} WHERE ${quoteIdent("name")} = $1`,
        [binKey],
      )
    )[0];
    if (!bin) return;
    const qty = Number(bin.qty ?? 0);
    const newValue = Number(bin.value ?? 0) + deltaValue;
    const newRate = qty > 0 ? newValue / qty : 0;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Bin"))}
       SET ${quoteIdent("stock_value")} = $1, ${quoteIdent("valuation_rate")} = $2,
           ${quoteIdent("modified")} = $3 WHERE ${quoteIdent("name")} = $4`,
      [newValue, newRate, new Date().toISOString(), binKey],
    );
  }

  /**
   * A submitted Landed Cost Voucher distributes an additional cost (freight,
   * duty) across the items of its Purchase Receipt — by their amount (qty×rate)
   * or by qty — increasing each item's Bin valuation. Each share is recorded as a
   * zero-quantity Stock Ledger Entry so cancel can reverse it exactly.
   */
  @OnEvent("doc.on_submit:Landed Cost Voucher")
  async onLandedCost(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const prDt = this.registry.get("Purchase Receipt");
    const sle = this.registry.get("Stock Ledger Entry");
    if (!prDt || !sle) return;
    const ctx = systemContext(payload.user);
    const total = Number(doc.additional_cost ?? 0);
    if (!total) return;
    const byQty = String(doc.distribute_by ?? "Amount") === "Qty";

    try {
      const pr = await this.documents.get(prDt, String(doc.purchase_receipt));
      const rows = (pr.items as Array<Record<string, unknown>>) ?? [];
      const basis = rows.map((r) => {
        const qty = Number(r.qty ?? 0);
        return byQty ? qty : qty * Number(r.rate ?? 0);
      });
      const totalBasis = basis.reduce((s, b) => s + b, 0);
      if (totalBasis <= 0) return;

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        const item = String(row.item_code ?? "");
        const warehouse = String(row.warehouse ?? "");
        if (!item || !warehouse) continue;
        const share = total * (basis[i] / totalBasis);
        if (!share) continue;
        await this.bumpBinValue(item, warehouse, share);
        const { qty, rate } = await this.binBalance(item, warehouse, "");
        await this.documents.create(sle, ctx, {
          posting_date: doc.posting_date ?? null,
          item_code: item,
          warehouse,
          actual_qty: 0,
          valuation_rate: rate,
          qty_after_transaction: qty,
          stock_value: share,
          voucher_type: "Landed Cost Voucher",
          voucher_no: doc.name,
        });
      }
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Landed Cost Voucher"))}
         SET ${quoteIdent("status")} = 'Applied' WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(`Applied Landed Cost ${doc.name}: distributed ${total} over ${rows.length} item(s)`);
    } catch (err) {
      this.logger.error(`Landed Cost ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Landed Cost Voucher")
  async cancelLandedCost(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Stock Ledger Entry")) return;
    const sles = await this.dataSource.query(
      `SELECT ${quoteIdent("item_code")} AS item, ${quoteIdent("warehouse")} AS wh,
              ${quoteIdent("stock_value")} AS value
       FROM ${quoteIdent(tableNameFor("Stock Ledger Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Landed Cost Voucher' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
    for (const s of sles) {
      await this.bumpBinValue(String(s.item), String(s.wh), -Number(s.value));
    }
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("Stock Ledger Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Landed Cost Voucher' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Landed Cost Voucher"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }

  private async setStatus(doctype: string, name: string, status: string, extra?: Record<string, unknown>): Promise<void> {
    const fields: Record<string, unknown> = { status, ...(extra ?? {}) };
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${sets} WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  /**
   * A Repack consumes items and produces others from the same warehouse. On
   * submit we issue each consumed line at its current valuation (summing the
   * consumed value), then receive the produced lines at a rolled-up rate so the
   * produced stock value equals the value consumed — cost is conserved, not
   * created. Cancel reverses every movement.
   */
  @OnEvent("doc.on_submit:Repack")
  async onRepack(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const ctx = systemContext(payload.user);
    const wh = String(doc.warehouse ?? "");
    let consumedValue = 0;
    for (const row of (doc.consume_items as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      const qty = Number(row.qty ?? 0);
      if (!item || !qty) continue;
      const { rate } = await this.binBalance(item, wh, "");
      consumedValue += qty * rate;
      try {
        await this.post(ctx, { item, warehouse: wh, delta: -qty }, "Repack", String(doc.name), doc.posting_date);
      } catch (err) {
        this.logger.error(`Repack ${doc.name}/${item}: ${(err as Error).message}`);
      }
    }
    const produce = (doc.produce_items as Array<Record<string, unknown>>) ?? [];
    const totalProduced = produce.reduce((s, r) => s + Number(r.qty ?? 0), 0);
    const rate = totalProduced > 0 ? consumedValue / totalProduced : 0;
    for (const row of produce) {
      const item = String(row.item_code ?? "");
      const qty = Number(row.qty ?? 0);
      if (!item || !qty) continue;
      try {
        await this.post(ctx, { item, warehouse: wh, delta: qty, incomingRate: rate }, "Repack", String(doc.name), doc.posting_date);
      } catch (err) {
        this.logger.error(`Repack ${doc.name}/${item}: ${(err as Error).message}`);
      }
    }
    await this.setStatus("Repack", String(doc.name), "Repacked", { consumed_value: consumedValue });
    this.logger.log(`Repack ${doc.name}: consumed ${consumedValue} into ${totalProduced} unit(s) @ ${rate}`);
  }

  @OnEvent("doc.on_cancel:Repack")
  async cancelRepack(p: DocEventPayload): Promise<void> {
    await this.reverse("Repack", String(p.doc.name));
    await this.setStatus("Repack", String(p.doc.name), "Cancelled");
  }

  /**
   * A Putaway moves received stock from a staging/receiving warehouse into
   * storage. Each line is a warehouse-to-warehouse transfer at the source's
   * current valuation (value follows the goods). Cancel reverses.
   */
  @OnEvent("doc.on_submit:Putaway")
  async onPutaway(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const ctx = systemContext(payload.user);
    const from = String(doc.from_warehouse ?? "");
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      const qty = Number(row.qty ?? 0);
      const to = String(row.to_warehouse ?? "");
      if (!item || !qty || !to) continue;
      const { rate } = await this.binBalance(item, from, "");
      try {
        await this.post(ctx, { item, warehouse: from, delta: -qty }, "Putaway", String(doc.name), doc.posting_date);
        await this.post(ctx, { item, warehouse: to, delta: qty, incomingRate: rate }, "Putaway", String(doc.name), doc.posting_date);
      } catch (err) {
        this.logger.error(`Putaway ${doc.name}/${item}: ${(err as Error).message}`);
      }
    }
    await this.setStatus("Putaway", String(doc.name), "Put Away");
    this.logger.log(`Putaway ${doc.name}: moved ${(doc.items as unknown[])?.length ?? 0} line(s) out of ${from}`);
  }

  @OnEvent("doc.on_cancel:Putaway")
  async cancelPutaway(p: DocEventPayload): Promise<void> {
    await this.reverse("Putaway", String(p.doc.name));
    await this.setStatus("Putaway", String(p.doc.name), "Cancelled");
  }

  /**
   * A Pick List cannot be submitted for more than what is on hand: the
   * before_submit gate (suppressErrors:false, so a throw aborts the submit)
   * checks each location's qty against the current Bin balance.
   */
  @OnEvent("doc.before_submit:Pick List", { suppressErrors: false })
  async gatePickList(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Bin")) return;
    const doc = payload.doc;
    for (const row of (doc.locations as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      const wh = String(row.warehouse ?? "");
      const qty = Number(row.qty ?? 0);
      if (!item || !wh || !qty) continue;
      const { qty: onHand } = await this.binBalance(item, wh, "");
      if (qty > onHand + 1e-9) {
        throw new BadRequestException(
          `Pick List ${doc.name}: cannot pick ${qty} of ${item} from ${wh} — only ${onHand} on hand`,
        );
      }
    }
    this.logger.log(`Pick List ${doc.name} passed availability gate`);
  }

  @OnEvent("doc.on_submit:Pick List")
  async onPickList(payload: DocEventPayload): Promise<void> {
    await this.setStatus("Pick List", String(payload.doc.name), "Picked");
  }
}
