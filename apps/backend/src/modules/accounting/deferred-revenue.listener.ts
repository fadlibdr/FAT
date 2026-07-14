import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Add `n` months to an ISO date, returning YYYY-MM-DD. */
function addMonths(value: unknown, n: number): string {
  const d = new Date(String(value));
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Deferred revenue. A schedule books the whole amount to a deferred-revenue
 * liability up front, then recognition (driven by DeferredRevenueService)
 * releases it to income month by month.
 *
 *  1. before_save splits the total into equal monthly installments (rounded, the
 *     last row absorbing the rounding remainder).
 *  2. on_submit posts Dr Receivable / Cr Deferred Revenue for the full amount.
 *  3. on_cancel reverses the GL.
 */
@Injectable()
export class DeferredRevenueListener {
  private readonly logger = new Logger(DeferredRevenueListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Deferred Revenue Schedule")
  onSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    const existing = (d.schedule as Array<Record<string, unknown>>) ?? [];
    if (existing.length > 0) return; // keep an explicit schedule as-is
    const total = Number(d.total_amount ?? 0);
    const months = Math.max(1, Math.trunc(Number(d.months ?? 0)));
    if (!total || !d.start_date) return;
    const per = Math.round((total / months) * 100) / 100;
    const rows: Array<Record<string, unknown>> = [];
    let allocated = 0;
    for (let i = 0; i < months; i += 1) {
      const amount = i === months - 1 ? Math.round((total - allocated) * 100) / 100 : per;
      allocated += amount;
      rows.push({ recognition_date: addMonths(d.start_date, i), amount, recognized: 0 });
    }
    d.schedule = rows;
  }

  @OnEvent("doc.on_submit:Deferred Revenue Schedule")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const total = Number(doc.total_amount ?? 0);
    const debit = String(doc.debit_account || "Debtors");
    const deferred = String(doc.deferred_account || "Deferred Revenue");
    const against = String(doc.customer ?? "");
    try {
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Deferred Revenue Schedule",
        voucher_no: String(doc.name), account: debit, debit: total, credit: 0, against,
      });
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Deferred Revenue Schedule",
        voucher_no: String(doc.name), account: deferred, debit: 0, credit: total, against,
      });
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Deferred Revenue Schedule"))}
         SET ${quoteIdent("status")} = 'Active', ${quoteIdent("recognized_amount")} = 0
         WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(`Deferred Revenue ${doc.name}: deferred ${total} (Dr ${debit} / Cr ${deferred})`);
    } catch (err) {
      this.logger.error(`Deferred Revenue ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Deferred Revenue Schedule")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Deferred Revenue Schedule' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Deferred Revenue Schedule"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
