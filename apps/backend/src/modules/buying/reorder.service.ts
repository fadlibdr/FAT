import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Automatic replenishment. A daily cron (also runnable on demand) finds Items
 * whose total on-hand quantity has fallen below their reorder level and raises a
 * single submitted Material Request (type Purchase) for the shortfall, then a
 * Material Request can be turned into a draft Purchase Order. Reuses the generic
 * DocumentService — no cross-module service imports.
 */
@Injectable()
export class ReorderService {
  private readonly logger = new Logger(ReorderService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async scheduled(): Promise<void> {
    const mr = await this.raiseReorderRequests();
    if (mr) this.logger.log(`Reorder run raised Material Request ${mr}`);
  }

  /**
   * Scan reorder-enabled Items, sum on-hand qty across warehouses, and raise one
   * Material Request for everything below its reorder level. Returns the new
   * Material Request name, or null if nothing needs reordering.
   */
  async raiseReorderRequests(asOf?: string): Promise<string | null> {
    const itemDt = this.registry.get("Item");
    const mrDt = this.registry.get("Material Request");
    if (!itemDt || !mrDt) return null;
    const ctx = systemContext();
    const today = asOf ?? new Date().toISOString().slice(0, 10);

    const items = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS item, coalesce(${quoteIdent("reorder_level")},0) AS level,
              coalesce(${quoteIdent("reorder_qty")},0) AS reorder_qty,
              coalesce(${quoteIdent("standard_rate")},0) AS rate
       FROM ${quoteIdent(tableNameFor("Item"))}
       WHERE coalesce(${quoteIdent("reorder_level")},0) > 0`,
    );

    const rows: Array<Record<string, unknown>> = [];
    for (const it of items) {
      const level = Number(it.level);
      const onHand = await this.onHandQty(String(it.item));
      if (onHand >= level) continue;
      // Prefer the configured reorder qty; else top up to the reorder level.
      const qty = Number(it.reorder_qty) > 0 ? Number(it.reorder_qty) : level - onHand;
      if (qty <= 0) continue;
      rows.push({ item_code: it.item, qty, rate: Number(it.rate) });
      this.logger.log(`Reorder: ${it.item} on-hand ${onHand} < level ${level} -> qty ${qty}`);
    }
    if (rows.length === 0) return null;

    const mr = await this.documents.create(mrDt, ctx, {
      material_request_type: "Purchase",
      transaction_date: today,
      status: "Pending",
      items: rows,
    });
    await this.documents.setDocStatus(mrDt, ctx, String(mr.name), 1);
    return String(mr.name);
  }

  /** Total on-hand quantity for an item across every Bin (all warehouses/batches). */
  private async onHandQty(item: string): Promise<number> {
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("actual_qty")}),0) AS q
         FROM ${quoteIdent(tableNameFor("Bin"))} WHERE ${quoteIdent("item_code")} = $1`,
        [item],
      )
    )[0];
    return Number(row?.q ?? 0);
  }

  /**
   * Turn a submitted Purchase-type Material Request into a draft Purchase Order
   * for the given supplier. Links the two, marks the request Ordered, and stamps
   * each request line's ordered_qty.
   */
  async makePurchaseOrder(mrName: string, supplier: string, ctx?: UserContext): Promise<string> {
    const mrDt = this.registry.get("Material Request");
    const poDt = this.registry.get("Purchase Order");
    if (!mrDt || !poDt) throw new BadRequestException("Buying doctypes not registered");
    if (!supplier) throw new BadRequestException("supplier is required");
    const context = ctx ?? systemContext();

    const mr = await this.documents.get(mrDt, mrName);
    if ((mr.docstatus ?? 0) !== 1) {
      throw new BadRequestException("Material Request must be submitted");
    }
    if (String(mr.material_request_type) !== "Purchase") {
      throw new BadRequestException("Only Purchase-type Material Requests can raise a Purchase Order");
    }
    if (String(mr.status) === "Ordered") {
      throw new BadRequestException(`Material Request ${mrName} is already Ordered`);
    }

    const mrItems = (mr.items as Array<Record<string, unknown>>) ?? [];
    const poItems = mrItems.map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      rate: Number(r.rate ?? 0),
    }));

    const po = await this.documents.create(poDt, context, {
      supplier,
      transaction_date: new Date().toISOString().slice(0, 10),
      company: mr.company ?? null,
      items: poItems,
    });

    for (const r of mrItems) {
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Material Request Item"))}
         SET ${quoteIdent("ordered_qty")} = ${quoteIdent("qty")} WHERE ${quoteIdent("name")} = $1`,
        [String(r.name)],
      );
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Material Request"))}
       SET ${quoteIdent("status")} = 'Ordered', ${quoteIdent("purchase_order")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [String(po.name), mrName],
    );
    this.logger.log(`Material Request ${mrName} -> Purchase Order ${po.name} (${supplier})`);
    return String(po.name);
  }
}
