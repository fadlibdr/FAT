import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Item Alternatives: substitute items usable when the primary is short. A
 * mapping may be one- or two-way; the lookup returns every alternative for an
 * item (following two-way mappings in reverse) with its current on-hand stock so
 * a planner can pick an in-stock substitute. Pure event-bus + SQL, no
 * cross-module service imports.
 */
@Injectable()
export class ItemAlternativeService {
  private readonly logger = new Logger(ItemAlternativeService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Reject a self-alternative or a duplicate mapping for the same item pair.
   *  suppressErrors:false so a throw aborts the create. */
  @OnEvent("doc.before_save:Item Alternative", { suppressErrors: false })
  async onSave(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    const item = String(d.item_code ?? "");
    const alt = String(d.alternative_item_code ?? "");
    if (item && alt && item === alt) {
      throw new BadRequestException("An item cannot be its own alternative");
    }
    if (!item || !alt || !this.registry.has("Item Alternative")) return;
    const dup = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS n FROM ${quoteIdent(tableNameFor("Item Alternative"))}
         WHERE ${quoteIdent("item_code")} = $1 AND ${quoteIdent("alternative_item_code")} = $2
           AND ${quoteIdent("name")} <> $3 LIMIT 1`,
        [item, alt, String(d.name ?? "")],
      )
    )[0];
    if (dup) {
      throw new BadRequestException(`${item} -> ${alt} is already mapped (${dup.n})`);
    }
  }

  /** On-hand quantity for an item across all warehouses. */
  private async onHand(item: string): Promise<number> {
    if (!this.registry.has("Bin")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("actual_qty")}), 0) AS q FROM ${quoteIdent(tableNameFor("Bin"))}
         WHERE ${quoteIdent("item_code")} = $1`,
        [item],
      )
    )[0];
    return Number(row?.q ?? 0);
  }

  /** Every alternative item for `item` (direct + reverse two-way), each with on-hand stock. */
  async alternativesFor(item: string): Promise<{ item_code: string; alternatives: Array<{ item_code: string; on_hand: number }> }> {
    if (!this.registry.has("Item Alternative")) return { item_code: item, alternatives: [] };
    const table = quoteIdent(tableNameFor("Item Alternative"));
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("alternative_item_code")} AS alt FROM ${table} WHERE ${quoteIdent("item_code")} = $1
       UNION
       SELECT ${quoteIdent("item_code")} AS alt FROM ${table}
       WHERE ${quoteIdent("alternative_item_code")} = $1 AND ${quoteIdent("two_way")} = 1`,
      [item],
    );
    const alternatives = [];
    for (const r of rows as Array<{ alt: string }>) {
      alternatives.push({ item_code: String(r.alt), on_hand: await this.onHand(String(r.alt)) });
    }
    this.logger.log(`Item ${item}: ${alternatives.length} alternative(s)`);
    return { item_code: item, alternatives };
  }
}
