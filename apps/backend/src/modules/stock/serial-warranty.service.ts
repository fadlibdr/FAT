import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Serial-number warranty lifecycle. When a Delivery Note is submitted, each
 * delivered serial is stamped with a `warranty_expiry_date` derived from the
 * item's warranty period (posting date + warranty_period_days), unless it
 * already carries one. A daily run (also on demand) recomputes every serial's
 * `warranty_status` from that date. Pure event-bus + SQL — no cross-module
 * service imports.
 */
@Injectable()
export class SerialWarrantyService {
  private readonly logger = new Logger(SerialWarrantyService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private static addDays(iso: string, days: number): string {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** Stamp warranty expiry on the serials a Delivery Note ships. */
  @OnEvent("doc.on_submit:Delivery Note")
  async onDelivery(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (Boolean(doc.is_return) || !this.registry.has("Serial No") || !this.registry.has("Item")) return;
    const posting = doc.posting_date
      ? new Date(doc.posting_date as string).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const serials = String(row.serial_no ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      if (serials.length === 0) continue;
      const item = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("warranty_period_days")} AS d FROM ${quoteIdent(tableNameFor("Item"))}
           WHERE ${quoteIdent("name")} = $1`,
          [String(row.item_code ?? "")],
        )
      )[0];
      const days = Number(item?.d ?? 0);
      if (days <= 0) continue;
      const expiry = SerialWarrantyService.addDays(posting, days);
      // Only stamp serials that don't already have an expiry (don't overwrite a manual/earlier value).
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Serial No"))}
         SET ${quoteIdent("warranty_expiry_date")} = $1
         WHERE ${quoteIdent("name")} = ANY($2) AND ${quoteIdent("warranty_expiry_date")} IS NULL`,
        [expiry, serials],
      );
      this.logger.log(`Delivery Note ${doc.name}: stamped warranty ${expiry} on ${serials.length} serial(s) of ${row.item_code}`);
    }
    await this.recompute(posting);
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async scheduled(): Promise<void> {
    const n = await this.recompute();
    if (n > 0) this.logger.log(`Serial warranty: recomputed ${n} serial(s)`);
  }

  /**
   * Recompute warranty_status for every serial: No Warranty when no expiry is
   * recorded, In Warranty when the expiry is on/after the as-of date, else Out
   * of Warranty. Returns the number of serials updated.
   */
  async recompute(asOf?: string): Promise<number> {
    if (!this.registry.has("Serial No")) return 0;
    const today = asOf ? String(asOf).slice(0, 10) : new Date().toISOString().slice(0, 10);
    const computed = `CASE
           WHEN ${quoteIdent("warranty_expiry_date")} IS NULL THEN 'No Warranty'
           WHEN ${quoteIdent("warranty_expiry_date")}::date >= $1::date THEN 'In Warranty'
           ELSE 'Out of Warranty'
         END`;
    const res = await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Serial No"))} SET ${quoteIdent("warranty_status")} = ${computed}
       WHERE ${quoteIdent("warranty_status")} IS DISTINCT FROM ${computed}
       RETURNING ${quoteIdent("name")}`,
      [today],
    );
    return Array.isArray(res) ? res.length : 0;
  }
}
