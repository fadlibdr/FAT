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
