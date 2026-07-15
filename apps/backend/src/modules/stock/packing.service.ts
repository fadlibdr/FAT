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
 * Packing Slips break a submitted Delivery Note into physical cases. A slip
 * pre-fills from the note's still-unpacked quantities; a before_submit gate keeps
 * the cumulative packed qty per item from exceeding what the note delivers. Pure
 * use of the generic DocumentService over sibling tables; no cross-module imports.
 */
@Injectable()
export class PackingService {
  private readonly logger = new Logger(PackingService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Delivered qty per item on a Delivery Note. */
  private async deliveredByItem(dn: string): Promise<Map<string, number>> {
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("item_code")} AS item, coalesce(sum(${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor("Delivery Note Item"))} WHERE ${quoteIdent("parent")} = $1
       GROUP BY ${quoteIdent("item_code")}`,
      [dn],
    );
    return new Map(rows.map((r: { item: string; qty: unknown }) => [String(r.item), Number(r.qty ?? 0)]));
  }

  /**
   * Cumulative packed qty per item across the note's submitted Packing Slips,
   * optionally excluding one slip (so a re-submit checks against the others).
   */
  private async packedByItem(dn: string, exclude?: string): Promise<Map<string, number>> {
    const params: unknown[] = [dn];
    let sql = `SELECT psi.${quoteIdent("item_code")} AS item, coalesce(sum(psi.${quoteIdent("qty")}), 0) AS qty
               FROM ${quoteIdent(tableNameFor("Packing Slip Item"))} psi
               JOIN ${quoteIdent(tableNameFor("Packing Slip"))} ps ON ps.${quoteIdent("name")} = psi.${quoteIdent("parent")}
               WHERE ps.${quoteIdent("delivery_note")} = $1 AND ps.${quoteIdent("docstatus")} = 1`;
    if (exclude) {
      params.push(exclude);
      sql += ` AND ps.${quoteIdent("name")} <> $2`;
    }
    sql += ` GROUP BY psi.${quoteIdent("item_code")}`;
    const rows = await this.dataSource.query(sql, params);
    return new Map(rows.map((r: { item: string; qty: unknown }) => [String(r.item), Number(r.qty ?? 0)]));
  }

  /**
   * Build a draft Packing Slip pre-filled with a submitted Delivery Note's still-
   * unpacked lines (delivered minus already-packed). Cases default to the next
   * single case number after existing slips.
   */
  async makeFromDeliveryNote(dn: string, ctx?: UserContext): Promise<string> {
    const dnDt = this.registry.get("Delivery Note");
    const psDt = this.registry.get("Packing Slip");
    if (!dnDt || !psDt) throw new BadRequestException("Delivery Note / Packing Slip not registered");
    const context = ctx ?? systemContext();
    const note = await this.documents.get(dnDt, dn);
    if ((note.docstatus ?? 0) !== 1) throw new BadRequestException("Delivery Note must be submitted");

    const delivered = await this.deliveredByItem(dn);
    const packed = await this.packedByItem(dn);
    const items: Array<Record<string, unknown>> = [];
    for (const [item, qty] of delivered) {
      const remaining = qty - (packed.get(item) ?? 0);
      if (remaining > 1e-9) items.push({ item_code: item, qty: Math.round(remaining * 1e6) / 1e6 });
    }
    if (items.length === 0) throw new BadRequestException(`Delivery Note ${dn} is already fully packed`);

    const nextCase = Number(
      (
        await this.dataSource.query(
          `SELECT coalesce(max(${quoteIdent("to_case_no")}), 0) AS c
           FROM ${quoteIdent(tableNameFor("Packing Slip"))} WHERE ${quoteIdent("delivery_note")} = $1`,
          [dn],
        )
      )[0]?.c ?? 0,
    );
    const ps = await this.documents.create(psDt, context, {
      delivery_note: dn,
      from_case_no: nextCase + 1,
      to_case_no: nextCase + 1,
      items,
    });
    this.logger.log(`Delivery Note ${dn} -> draft Packing Slip ${ps.name} (${items.length} item(s), case ${nextCase + 1})`);
    return String(ps.name);
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Packing Slip", { suppressErrors: false })
  async gatePacking(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dn = String(doc.delivery_note ?? "");
    if (!dn) throw new BadRequestException("Packing Slip needs a Delivery Note");
    const from = Number(doc.from_case_no ?? 0);
    const to = Number(doc.to_case_no ?? 0);
    if (from && to && from > to) {
      throw new BadRequestException(`Packing Slip ${doc.name}: from case ${from} is after to case ${to}`);
    }
    const delivered = await this.deliveredByItem(dn);
    const packed = await this.packedByItem(dn, String(doc.name));
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      const qty = Number(row.qty ?? 0);
      if (!item || !qty) continue;
      const cap = delivered.get(item) ?? 0;
      const already = packed.get(item) ?? 0;
      if (already + qty > cap + 1e-9) {
        throw new BadRequestException(
          `Packing Slip ${doc.name}: packing ${qty} of ${item} exceeds Delivery Note ${dn} — delivered ${cap}, already packed ${already}`,
        );
      }
    }
  }
}
