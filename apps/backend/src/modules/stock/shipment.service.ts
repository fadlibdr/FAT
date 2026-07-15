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

/**
 * A Shipment groups one or more submitted Delivery Notes into a single carrier
 * consignment. Its weight is aggregated from the notes' Packing Slips; a
 * before_submit gate keeps a note from riding on two shipments. Pure use of the
 * generic DocumentService over sibling tables; no cross-module imports.
 */
@Injectable()
export class ShipmentService {
  private readonly logger = new Logger(ShipmentService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Total packed net weight recorded on a Delivery Note's submitted Packing Slips. */
  private async noteWeight(dn: string): Promise<number> {
    if (!this.registry.has("Packing Slip")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("net_weight")}), 0) AS w
         FROM ${quoteIdent(tableNameFor("Packing Slip"))}
         WHERE ${quoteIdent("delivery_note")} = $1 AND ${quoteIdent("docstatus")} = 1`,
        [dn],
      )
    )[0];
    return Number(row?.w ?? 0);
  }

  /**
   * Build a draft Shipment from a set of submitted Delivery Notes, pulling each
   * note's customer and summing its packing-slip weight into the shipment total.
   */
  async makeFromDeliveryNotes(notes: string[], carrier: string, awb: string, ctx?: UserContext): Promise<string> {
    const dnDt = this.registry.get("Delivery Note");
    const shipDt = this.registry.get("Shipment");
    if (!dnDt || !shipDt) throw new BadRequestException("Delivery Note / Shipment not registered");
    const context = ctx ?? systemContext();
    const unique = [...new Set((notes ?? []).filter(Boolean).map(String))];
    if (unique.length === 0) throw new BadRequestException("At least one Delivery Note is required");

    const rows: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const dn of unique) {
      const note = await this.documents.get(dnDt, dn);
      if ((note.docstatus ?? 0) !== 1) throw new BadRequestException(`Delivery Note ${dn} must be submitted`);
      const weight = await this.noteWeight(dn);
      total += weight;
      rows.push({ delivery_note: dn, customer: note.customer ?? null, weight });
    }
    const ship = await this.documents.create(shipDt, context, {
      pickup_date: new Date().toISOString().slice(0, 10),
      carrier: carrier || null,
      awb_number: awb || null,
      total_weight: Math.round(total * 1e6) / 1e6,
      delivery_notes: rows,
    });
    this.logger.log(`Shipment ${ship.name}: ${rows.length} note(s), weight ${total}`);
    return String(ship.name);
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Shipment", { suppressErrors: false })
  async gateShipment(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const rows = (doc.delivery_notes as Array<Record<string, unknown>>) ?? [];
    if (rows.length === 0) throw new BadRequestException("Shipment needs at least one Delivery Note");
    const dnDt = this.registry.get("Delivery Note");
    for (const row of rows) {
      const dn = String(row.delivery_note ?? "");
      if (!dn) continue;
      if (dnDt) {
        const note = await this.documents.get(dnDt, dn);
        if ((note.docstatus ?? 0) !== 1) {
          throw new BadRequestException(`Shipment ${doc.name}: Delivery Note ${dn} is not submitted`);
        }
      }
      const clash = (
        await this.dataSource.query(
          `SELECT sh.${quoteIdent("name")} AS name
           FROM ${quoteIdent(tableNameFor("Shipment Delivery Note"))} sdn
           JOIN ${quoteIdent(tableNameFor("Shipment"))} sh ON sh.${quoteIdent("name")} = sdn.${quoteIdent("parent")}
           WHERE sdn.${quoteIdent("delivery_note")} = $1 AND sh.${quoteIdent("docstatus")} = 1
             AND sh.${quoteIdent("name")} <> $2
           LIMIT 1`,
          [dn, String(doc.name)],
        )
      )[0];
      if (clash) {
        throw new BadRequestException(
          `Shipment ${doc.name}: Delivery Note ${dn} is already on shipment ${clash.name}`,
        );
      }
    }
  }
}
