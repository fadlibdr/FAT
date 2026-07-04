import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Posts Stock Ledger Entries when a Stock Entry is submitted and reverses them
 * on cancel. Stock reacts to Stock Entry via the event bus; no cross-module
 * service imports.
 */
@Injectable()
export class StockLedgerListener {
  private readonly logger = new Logger(StockLedgerListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Stock Entry")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const dt = this.registry.get("Stock Ledger Entry");
    if (!dt) return;
    const doc = payload.doc;
    const purpose = String(doc.purpose ?? "");
    const items = (doc.items as Array<Record<string, unknown>>) ?? [];
    const ctx = systemContext(payload.user);

    for (const row of items) {
      const qty = Number(row.qty ?? 0);
      if (!qty) continue;
      // Receipt adds to target; Issue removes from source; Transfer does both.
      const movements: Array<{ warehouse: unknown; delta: number }> = [];
      if (purpose === "Material Receipt") {
        movements.push({ warehouse: row.t_warehouse, delta: qty });
      } else if (purpose === "Material Issue") {
        movements.push({ warehouse: row.s_warehouse, delta: -qty });
      } else {
        if (row.s_warehouse) movements.push({ warehouse: row.s_warehouse, delta: -qty });
        if (row.t_warehouse) movements.push({ warehouse: row.t_warehouse, delta: qty });
      }
      for (const m of movements) {
        if (!m.warehouse) continue;
        try {
          await this.documents.create(dt, ctx, {
            posting_date: doc.posting_date ?? null,
            item_code: row.item_code,
            warehouse: m.warehouse,
            actual_qty: m.delta,
            voucher_type: "Stock Entry",
            voucher_no: doc.name,
          });
        } catch (err) {
          this.logger.error(
            `Failed SLE for ${doc.name}/${String(row.item_code)}: ${(err as Error).message}`,
          );
        }
      }
    }
    this.logger.log(`Posted stock ledger for Stock Entry ${doc.name}`);
  }

  @OnEvent("doc.on_cancel:Stock Entry")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Stock Ledger Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("Stock Ledger Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      ["Stock Entry", payload.doc.name],
    );
    this.logger.log(`Reversed stock ledger for cancelled Stock Entry ${payload.doc.name}`);
  }
}
