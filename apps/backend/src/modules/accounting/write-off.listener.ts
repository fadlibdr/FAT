import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Bad-debt write-off. Writes off an uncollectable receivable: books Dr Bad Debt
 * Expense / Cr Debtors and, when the write-off targets a specific Sales Invoice,
 * reduces that invoice's outstanding and marks it Written Off once cleared. Pure
 * event-bus listener — no cross-module service imports.
 *
 *  1. before_save defaults the amount to the linked invoice's outstanding.
 *  2. before_submit gates the amount against that outstanding.
 *  3. on_submit posts the GL and adjusts the invoice; on_cancel reverses both.
 */
@Injectable()
export class WriteOffListener {
  private readonly logger = new Logger(WriteOffListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async invoiceOutstanding(name: string): Promise<number | null> {
    if (!name || !this.registry.has("Sales Invoice")) return null;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(${quoteIdent("outstanding_amount")}, 0) AS o
         FROM ${quoteIdent(tableNameFor("Sales Invoice"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    return row ? Number(row.o) : null;
  }

  @OnEvent("doc.before_save:Write Off Entry")
  async onSave(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    if ((d.write_off_amount === undefined || d.write_off_amount === null || d.write_off_amount === "") && d.sales_invoice) {
      const outstanding = await this.invoiceOutstanding(String(d.sales_invoice));
      if (outstanding !== null) d.write_off_amount = outstanding;
    }
  }

  // suppressErrors:false so an over-write-off aborts the submit.
  @OnEvent("doc.before_submit:Write Off Entry", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = Number(doc.write_off_amount ?? 0);
    if (amount <= 0) throw new BadRequestException(`Write Off Entry ${doc.name}: amount must be greater than zero`);
    if (doc.sales_invoice) {
      const outstanding = await this.invoiceOutstanding(String(doc.sales_invoice));
      if (outstanding !== null && round2(amount) > round2(outstanding) + 0.0001) {
        throw new BadRequestException(
          `Write Off Entry ${doc.name}: amount ${amount} exceeds invoice ${doc.sales_invoice} outstanding ${outstanding}`,
        );
      }
    }
  }

  @OnEvent("doc.on_submit:Write Off Entry")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const amount = round2(Number(doc.write_off_amount ?? 0));
    if (amount <= 0) return;
    const expense = String(doc.write_off_account || "Bad Debt Expense");
    const debtors = String(doc.debtors_account || "Debtors");
    const against = String(doc.customer ?? "");
    try {
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Write Off Entry",
        voucher_no: String(doc.name), account: expense, debit: amount, credit: 0, against,
      });
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Write Off Entry",
        voucher_no: String(doc.name), account: debtors, debit: 0, credit: amount, against,
      });
      if (doc.sales_invoice) await this.applyToInvoice(String(doc.sales_invoice), -amount);
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Write Off Entry"))} SET ${quoteIdent("status")} = 'Submitted'
         WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(`Write Off ${doc.name}: ${amount} (Dr ${expense} / Cr ${debtors})`);
    } catch (err) {
      this.logger.error(`Write Off ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Write Off Entry")
  async onCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = 'Write Off Entry' AND ${quoteIdent("voucher_no")} = $1`,
        [String(doc.name)],
      );
    }
    if (doc.sales_invoice) await this.applyToInvoice(String(doc.sales_invoice), round2(Number(doc.write_off_amount ?? 0)));
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Write Off Entry"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(doc.name)],
    );
  }

  /** Adjust an invoice's outstanding by `delta` (negative on write-off) and reset status. */
  private async applyToInvoice(invoice: string, delta: number): Promise<void> {
    const current = await this.invoiceOutstanding(invoice);
    if (current === null) return;
    const next = round2(current + delta);
    const status = next <= 0.0001 ? (delta < 0 ? "Written Off" : "Paid") : "Unpaid";
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Sales Invoice"))}
       SET ${quoteIdent("outstanding_amount")} = $1, ${quoteIdent("status")} = $2
       WHERE ${quoteIdent("name")} = $3`,
      [next < 0 ? 0 : next, status, invoice],
    );
  }
}
