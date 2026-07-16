import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Small tolerance so floating-point sums don't trip an exact-capacity gate. */
const TOL = 0.0001;

/**
 * Warehouse capacity control. A Warehouse may declare a `max_capacity` (total
 * units it can hold across all items); an inbound stock move that would push the
 * warehouse's on-hand past that cap is blocked before submit. Guards both
 * Putaway (per line `to_warehouse`) and inbound Stock Entry lines (per line
 * `t_warehouse` — Material Receipt / Transfer / Manufacture). Pure event-bus
 * listener — reads via SQL, no cross-module service imports.
 */
@Injectable()
export class WarehouseCapacityListener {
  private readonly logger = new Logger(WarehouseCapacityListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_submit:Putaway", { suppressErrors: false })
  async gatePutaway(payload: DocEventPayload): Promise<void> {
    await this.gate(payload.doc, "to_warehouse");
  }

  @OnEvent("doc.before_submit:Stock Entry", { suppressErrors: false })
  async gateStockEntry(payload: DocEventPayload): Promise<void> {
    await this.gate(payload.doc, "t_warehouse");
  }

  /** Block a submit whose incoming quantity would overflow any target warehouse. */
  private async gate(doc: Record<string, unknown>, warehouseField: string): Promise<void> {
    if (!this.registry.has("Warehouse")) return;
    const incoming = new Map<string, number>();
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const wh = String(row[warehouseField] ?? "");
      const qty = Number(row.qty ?? 0);
      if (!wh || qty <= 0) continue;
      incoming.set(wh, (incoming.get(wh) ?? 0) + qty);
    }

    for (const [wh, qty] of incoming) {
      const capacity = await this.capacityOf(wh);
      if (capacity <= 0) continue; // no cap declared
      const onHand = await this.onHandOf(wh);
      if (onHand + qty > capacity + TOL) {
        throw new BadRequestException(
          `${doc.name}: warehouse ${wh} capacity ${capacity} exceeded — on hand ${onHand} + incoming ${qty}`,
        );
      }
    }
  }

  /** Declared max capacity of a warehouse (0 / unset = unlimited). */
  private async capacityOf(warehouse: string): Promise<number> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("max_capacity")} AS cap FROM ${quoteIdent(tableNameFor("Warehouse"))}
         WHERE ${quoteIdent("name")} = $1`,
        [warehouse],
      )
    )[0];
    return Number(row?.cap ?? 0);
  }

  /** Total on-hand units in a warehouse across all items (from the Bin ledger). */
  private async onHandOf(warehouse: string): Promise<number> {
    if (!this.registry.has("Bin")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("actual_qty")}), 0) AS q FROM ${quoteIdent(tableNameFor("Bin"))}
         WHERE ${quoteIdent("warehouse")} = $1`,
        [warehouse],
      )
    )[0];
    return Number(row?.q ?? 0);
  }
}
