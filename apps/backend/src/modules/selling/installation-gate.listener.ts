import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Small tolerance so floating-point sums don't trip an exact-quantity gate. */
const TOL = 0.0001;

/**
 * Installation control. An Installation Note may not install more of any item
 * than the linked Delivery Note delivered. Before submit, the already-installed
 * quantity per item (from other submitted notes against the same delivery) plus
 * this note's lines is checked against the delivered quantity, and an
 * over-install aborts the submit. Pure event-bus listener — reads via SQL, no
 * cross-module service imports.
 */
@Injectable()
export class InstallationGateListener {
  private readonly logger = new Logger(InstallationGateListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so an over-install aborts the submit.
  @OnEvent("doc.before_submit:Installation Note", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dn = String(doc.delivery_note ?? "");
    if (!dn || !this.registry.has("Delivery Note")) return;

    const delivered = await this.deliveredByItem(dn);
    if (delivered.size === 0) return;
    const already = await this.installedByItem(dn);

    const incoming = new Map<string, number>();
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      const qty = Number(row.qty ?? 0);
      if (!item || !qty) continue;
      incoming.set(item, (incoming.get(item) ?? 0) + qty);
    }

    for (const [item, qty] of incoming) {
      const deliveredQty = delivered.get(item) ?? 0;
      const doneQty = already.get(item) ?? 0;
      if (doneQty + qty > deliveredQty + TOL) {
        throw new BadRequestException(
          `Installation Note ${doc.name}: item ${item} installed ${doneQty + qty} exceeds ` +
            `Delivery Note ${dn} delivered ${deliveredQty} (already installed ${doneQty})`,
        );
      }
    }
  }

  private async deliveredByItem(dn: string): Promise<Map<string, number>> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("item_code")} AS item, coalesce(sum(${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor("Delivery Note Item"))} WHERE ${quoteIdent("parent")} = $1
       GROUP BY ${quoteIdent("item_code")}`,
      [dn],
    );
    return new Map(rows.map((r) => [String(r.item), Number(r.qty ?? 0)]));
  }

  private async installedByItem(dn: string): Promise<Map<string, number>> {
    if (!this.registry.has("Installation Note")) return new Map();
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT c.${quoteIdent("item_code")} AS item, coalesce(sum(c.${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor("Installation Note Item"))} c
       JOIN ${quoteIdent(tableNameFor("Installation Note"))} p ON c.${quoteIdent("parent")} = p.${quoteIdent("name")}
       WHERE p.${quoteIdent("delivery_note")} = $1 AND p.${quoteIdent("docstatus")} = 1
       GROUP BY c.${quoteIdent("item_code")}`,
      [dn],
    );
    return new Map(rows.map((r) => [String(r.item), Number(r.qty ?? 0)]));
  }
}
