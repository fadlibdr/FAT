import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Turns a submitted Pick List into a draft Delivery Note — the outbound flow's
 * next step. Pure use of the generic DocumentService over sibling tables; no
 * cross-module service imports.
 */
@Injectable()
export class PickListService {
  private readonly logger = new Logger(PickListService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Build a draft Pick List from a submitted Sales Order. Each ordered line
   * becomes a pick location, its warehouse resolved to the Bin holding the most
   * available stock for that item; an item with no positive stock anywhere aborts
   * the pick. The Pick List links back to the sales order.
   */
  async makeFromSalesOrder(so: string, ctx?: UserContext): Promise<string> {
    const soDt = this.registry.get("Sales Order");
    const pickDt = this.registry.get("Pick List");
    if (!soDt || !pickDt) throw new BadRequestException("Sales Order / Pick List not registered");
    const context = ctx ?? systemContext();
    const order = await this.documents.get(soDt, so);
    if ((order.docstatus ?? 0) !== 1) throw new BadRequestException("Sales Order must be submitted");

    const locations: Array<Record<string, unknown>> = [];
    for (const r of (order.items as Array<Record<string, unknown>>) ?? []) {
      const item = String(r.item_code ?? "");
      const warehouse = await this.resolveWarehouse(item);
      locations.push({ item_code: item, warehouse, qty: Number(r.qty ?? 0), rate: Number(r.rate ?? 0) });
    }
    if (locations.length === 0) throw new BadRequestException(`Sales Order ${so} has no items to pick`);

    const pick = await this.documents.create(pickDt, context, {
      customer: order.customer,
      posting_date: new Date().toISOString().slice(0, 10),
      sales_order: so,
      locations,
    });
    this.logger.log(`Sales Order ${so} -> draft Pick List ${pick.name} (${locations.length} lines)`);
    return String(pick.name);
  }

  /** Warehouse with the most available stock for an item, else abort the pick. */
  private async resolveWarehouse(item: string): Promise<string> {
    if (!this.registry.has("Bin")) throw new BadRequestException("Bin not registered");
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("warehouse")} AS warehouse
         FROM ${quoteIdent(tableNameFor("Bin"))}
         WHERE ${quoteIdent("item_code")} = $1 AND coalesce(${quoteIdent("actual_qty")}, 0) > 0
         ORDER BY ${quoteIdent("actual_qty")} DESC
         LIMIT 1`,
        [item],
      )
    )[0];
    if (!row) throw new BadRequestException(`No stock available to pick for item ${item}`);
    return String(row.warehouse);
  }

  async makeDeliveryNote(name: string, ctx?: UserContext): Promise<string> {
    const pickDt = this.registry.get("Pick List");
    const dnDt = this.registry.get("Delivery Note");
    if (!pickDt || !dnDt) throw new BadRequestException("Pick List / Delivery Note not registered");
    const context = ctx ?? systemContext();
    const pick = await this.documents.get(pickDt, name);
    if ((pick.docstatus ?? 0) !== 1) throw new BadRequestException("Pick List must be submitted");
    if (!pick.customer) throw new BadRequestException("Pick List has no customer to deliver to");
    if (pick.delivery_note) throw new BadRequestException(`Pick List already delivered via ${pick.delivery_note}`);

    const items = ((pick.locations as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: r.qty,
      rate: r.rate ?? 0,
      warehouse: r.warehouse,
    }));
    const dn = await this.documents.create(dnDt, context, {
      customer: pick.customer,
      posting_date: pick.posting_date,
      items,
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Pick List"))}
       SET ${quoteIdent("delivery_note")} = $1, ${quoteIdent("status")} = 'Delivered'
       WHERE ${quoteIdent("name")} = $2`,
      [dn.name, name],
    );
    this.logger.log(`Pick List ${name} -> draft Delivery Note ${dn.name}`);
    return String(dn.name);
  }
}
