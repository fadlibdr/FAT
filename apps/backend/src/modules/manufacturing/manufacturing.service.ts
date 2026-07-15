import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Make-to-order: raise Work Orders to produce the manufactured items of a
 * submitted Sales Order. Each ordered line whose item has a default, active BOM
 * becomes a draft Work Order linked back to the order; lines with no BOM are left
 * to be bought or shipped from stock. Created through the generic DocumentService —
 * manufacturing imports no other module's services.
 */
@Injectable()
export class ManufacturingService {
  private readonly logger = new Logger(ManufacturingService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async makeWorkOrders(salesOrder: string, ctx?: UserContext): Promise<{ workOrders: string[]; skipped: string[] }> {
    const soDt = this.registry.get("Sales Order");
    const woDt = this.registry.get("Work Order");
    if (!soDt || !woDt) throw new BadRequestException("Sales Order or Work Order not registered");
    const context = ctx ?? systemContext();
    const order = await this.documents.get(soDt, salesOrder);
    if ((order.docstatus ?? 0) !== 1) throw new BadRequestException("Sales Order must be submitted");

    const workOrders: string[] = [];
    const skipped: string[] = [];
    for (const row of (order.items as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      if (!item) continue;
      const bom = await this.defaultBom(item);
      if (!bom) {
        skipped.push(item);
        continue;
      }
      const wo = await this.documents.create(woDt, context, {
        production_item: item,
        bom,
        qty: Number(row.qty ?? 0),
        sales_order: salesOrder,
        status: "Draft",
      });
      workOrders.push(String(wo.name));
      this.logger.log(`Sales Order ${salesOrder}: Work Order ${wo.name} for ${item} (BOM ${bom})`);
    }
    if (workOrders.length === 0) {
      throw new BadRequestException(`Sales Order ${salesOrder}: no ordered items have a default BOM to manufacture`);
    }
    return { workOrders, skipped };
  }

  /** The item's default active BOM, if any. */
  private async defaultBom(item: string): Promise<string | null> {
    if (!this.registry.has("BOM")) return null;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("BOM"))}
         WHERE ${quoteIdent("item")} = $1 AND coalesce(${quoteIdent("is_active")}, 0) = 1
         ORDER BY coalesce(${quoteIdent("is_default")}, 0) DESC, ${quoteIdent("name")}
         LIMIT 1`,
        [item],
      )
    )[0];
    return row ? String(row.name) : null;
  }
}
