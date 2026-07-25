import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Putaway Rules decide where incoming stock of an item should land: each rule
 * caps how much of an item a warehouse may hold. The suggestion endpoint spreads
 * an incoming quantity across the item's rules in priority order, filling each
 * warehouse's free space (rule capacity − current on-hand) before moving on.
 * Pure event-bus + SQL, no cross-module service imports.
 */
@Injectable()
export class PutawayRuleService {
  private readonly logger = new Logger(PutawayRuleService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Reject a non-positive capacity or a duplicate item+warehouse rule. */
  @OnEvent("doc.before_save:Putaway Rule", { suppressErrors: false })
  async onSave(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    if (Number(d.capacity ?? 0) <= 0) {
      throw new BadRequestException("Capacity must be greater than zero");
    }
    const item = String(d.item_code ?? "");
    const warehouse = String(d.warehouse ?? "");
    if (!item || !warehouse || !this.registry.has("Putaway Rule")) return;
    const dup = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS n FROM ${quoteIdent(tableNameFor("Putaway Rule"))}
         WHERE ${quoteIdent("item_code")} = $1 AND ${quoteIdent("warehouse")} = $2 AND ${quoteIdent("name")} <> $3 LIMIT 1`,
        [item, warehouse, String(d.name ?? "")],
      )
    )[0];
    if (dup) {
      throw new BadRequestException(`A putaway rule for ${item} in ${warehouse} already exists (${dup.n})`);
    }
  }

  /** On-hand quantity of an item in a specific warehouse. */
  private async onHand(item: string, warehouse: string): Promise<number> {
    if (!this.registry.has("Bin")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("actual_qty")}), 0) AS q FROM ${quoteIdent(tableNameFor("Bin"))}
         WHERE ${quoteIdent("item_code")} = $1 AND ${quoteIdent("warehouse")} = $2`,
        [item, warehouse],
      )
    )[0];
    return Number(row?.q ?? 0);
  }

  /**
   * Suggest how to distribute `qty` of `item` across its putaway rules. Fills
   * each warehouse's free space in priority order; `unassigned` is whatever won't
   * fit anywhere.
   */
  async suggest(item: string, qty: number): Promise<{
    item_code: string;
    requested: number;
    assignments: Array<{ warehouse: string; qty: number; free: number }>;
    unassigned: number;
  }> {
    const requested = Math.max(0, Number(qty) || 0);
    if (!item || requested <= 0 || !this.registry.has("Putaway Rule")) {
      return { item_code: item, requested, assignments: [], unassigned: requested };
    }
    const rules = await this.dataSource.query(
      `SELECT ${quoteIdent("warehouse")} AS warehouse, coalesce(${quoteIdent("capacity")}, 0)::float8 AS capacity,
              coalesce(${quoteIdent("priority")}, 1) AS priority
       FROM ${quoteIdent(tableNameFor("Putaway Rule"))} WHERE ${quoteIdent("item_code")} = $1
       ORDER BY coalesce(${quoteIdent("priority")}, 1), ${quoteIdent("warehouse")}`,
      [item],
    );
    let remaining = requested;
    const assignments: Array<{ warehouse: string; qty: number; free: number }> = [];
    for (const r of rules as Array<{ warehouse: string; capacity: number }>) {
      if (remaining <= 0) break;
      const free = Math.max(0, Number(r.capacity) - (await this.onHand(item, String(r.warehouse))));
      if (free <= 0) continue;
      const put = Math.min(free, remaining);
      assignments.push({ warehouse: String(r.warehouse), qty: put, free });
      remaining -= put;
    }
    this.logger.log(`Putaway ${item} x${requested}: ${assignments.length} warehouse(s), ${remaining} unassigned`);
    return { item_code: item, requested, assignments, unassigned: remaining };
  }
}
