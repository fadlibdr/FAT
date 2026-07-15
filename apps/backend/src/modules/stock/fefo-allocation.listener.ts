import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

interface BatchAvail {
  batch: string;
  qty: number;
}

/**
 * FEFO (First-Expiry-First-Out) batch auto-allocation for deliveries. Before a
 * Delivery Note is written, any line for a batched item that names no batch is
 * split across the earliest-expiring, non-expired batches that hold on-hand
 * stock in the line's warehouse — nearest expiry drawn first, expired batches
 * skipped entirely. Each produced line carries its own batch_no and allocated
 * qty, so the existing per-batch stock move, availability gate, and expiry gate
 * all act on real batches. Pure before_save listener, no cross-module imports.
 *
 *   line: 8 of ITEM (no batch)  ->  5 of ITEM [batch expiring soonest]
 *                                    3 of ITEM [next batch]
 *
 * A line that already names a batch, a non-batched item, or a return delivery is
 * left untouched. If the non-expired batches cannot cover the qty, the shortfall
 * stays on an unbatched line so the availability gate rejects the submit.
 */
@Injectable()
export class FefoAllocationListener {
  private readonly logger = new Logger(FefoAllocationListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Delivery Note")
  async onBeforeSave(payload: BeforeSavePayload): Promise<void> {
    const data = payload.data;
    if (Boolean(data.is_return)) return;
    if (!this.registry.has("Bin") || !this.registry.has("Batch") || !this.registry.has("Item")) return;
    const rows = data.items as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(rows) || rows.length === 0) return;

    const asOf = data.posting_date ? String(data.posting_date).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const batchedCache = new Map<string, boolean>();
    const out: Array<Record<string, unknown>> = [];
    let changed = false;

    for (const row of rows) {
      const item = String(row.item_code ?? "");
      const wh = String(row.warehouse ?? "");
      const qty = Number(row.qty ?? 0);
      // Only auto-allocate a batched item line that carries no batch and a real qty/warehouse.
      if (!item || !wh || qty <= 0 || String(row.batch_no ?? "")) {
        out.push(row);
        continue;
      }
      if (!(await this.isBatched(item, batchedCache))) {
        out.push(row);
        continue;
      }

      const avail = await this.availableBatches(item, wh, asOf);
      if (avail.length === 0) {
        out.push(row); // nothing to draw from — leave for the availability gate
        continue;
      }

      let remaining = qty;
      const allocations: BatchAvail[] = [];
      for (const b of avail) {
        if (remaining <= 1e-9) break;
        const take = Math.min(remaining, b.qty);
        if (take <= 1e-9) continue;
        allocations.push({ batch: b.batch, qty: Math.round(take * 1e6) / 1e6 });
        remaining -= take;
      }
      if (allocations.length === 0) {
        out.push(row);
        continue;
      }

      for (const a of allocations) {
        out.push({ ...row, qty: a.qty, batch_no: a.batch });
      }
      // Any shortfall the non-expired batches could not cover stays unbatched so
      // the availability gate reports it on submit.
      if (remaining > 1e-9) {
        out.push({ ...row, qty: Math.round(remaining * 1e6) / 1e6, batch_no: "" });
      }
      changed = true;
      this.logger.log(
        `FEFO Delivery Note: ${qty} of ${item} @ ${wh} -> ${allocations.map((a) => `${a.qty}×${a.batch}`).join(", ")}` +
          (remaining > 1e-9 ? ` (+${Math.round(remaining * 1e6) / 1e6} unallocated)` : ""),
      );
    }

    if (changed) data.items = out;
  }

  private async isBatched(item: string, cache: Map<string, boolean>): Promise<boolean> {
    const hit = cache.get(item);
    if (hit !== undefined) return hit;
    const rec = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("has_batch_no")} AS flag FROM ${quoteIdent(tableNameFor("Item"))}
         WHERE ${quoteIdent("name")} = $1`,
        [item],
      )
    )[0];
    const flag = Boolean(Number(rec?.flag ?? 0));
    cache.set(item, flag);
    return flag;
  }

  /**
   * On-hand batches for an item+warehouse that have not expired on/before the
   * posting date, ordered nearest-expiry-first (null-expiry batches last).
   */
  private async availableBatches(item: string, warehouse: string, asOf: string): Promise<BatchAvail[]> {
    const rows = await this.dataSource.query(
      `SELECT b.${quoteIdent("batch_no")} AS batch, b.${quoteIdent("actual_qty")} AS qty
       FROM ${quoteIdent(tableNameFor("Bin"))} b
       JOIN ${quoteIdent(tableNameFor("Batch"))} bt ON bt.${quoteIdent("name")} = b.${quoteIdent("batch_no")}
       WHERE b.${quoteIdent("item_code")} = $1 AND b.${quoteIdent("warehouse")} = $2
         AND coalesce(b.${quoteIdent("batch_no")}, '') <> ''
         AND b.${quoteIdent("actual_qty")} > 0
         AND (bt.${quoteIdent("expiry_date")} IS NULL OR bt.${quoteIdent("expiry_date")}::date > $3::date)
       ORDER BY bt.${quoteIdent("expiry_date")} ASC NULLS LAST, b.${quoteIdent("batch_no")} ASC`,
      [item, warehouse, asOf],
    );
    return rows.map((r: { batch: string; qty: unknown }) => ({ batch: String(r.batch), qty: Number(r.qty ?? 0) }));
  }
}
