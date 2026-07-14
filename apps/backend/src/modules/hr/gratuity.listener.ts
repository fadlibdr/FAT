import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const DAY_MS = 86_400_000;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * End-of-service gratuity. Provisions a leaving employee's gratuity — a number of
 * days' salary per year of service — and books it as an expense against a payable.
 * Pure event-bus listener, no cross-module service imports.
 *
 *  1. before_save computes service years (relieving − joining) and the gratuity
 *     amount = (monthly salary ÷ 30) × days-per-year × service years.
 *  2. on_submit books Dr Gratuity Expense / Cr Gratuity Payable; on_cancel reverses.
 */
@Injectable()
export class GratuityListener {
  private readonly logger = new Logger(GratuityListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Gratuity")
  onSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    if (!d.date_of_joining || !d.relieving_date) return;
    const joined = new Date(String(d.date_of_joining)).getTime();
    const left = new Date(String(d.relieving_date)).getTime();
    const years = Math.max(0, (left - joined) / DAY_MS / 365.25);
    const serviceYears = Math.round(years * 100) / 100;
    const dailySalary = Number(d.monthly_salary ?? 0) / 30;
    const slabDays = Number(d.slab_days_per_year ?? 0);
    d.service_years = serviceYears;
    d.gratuity_amount = round2(dailySalary * slabDays * serviceYears);
  }

  @OnEvent("doc.on_submit:Gratuity")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const amount = Number(doc.gratuity_amount ?? 0);
    if (amount <= 0) return;
    const expense = String(doc.expense_account || "Gratuity Expense");
    const payable = String(doc.payable_account || "Gratuity Payable");
    const against = String(doc.employee ?? "");
    const postingDate = doc.posting_date ?? doc.relieving_date ?? null;
    try {
      await this.documents.create(dt, ctx, {
        posting_date: postingDate, voucher_type: "Gratuity", voucher_no: String(doc.name),
        account: expense, debit: amount, credit: 0, against,
      });
      await this.documents.create(dt, ctx, {
        posting_date: postingDate, voucher_type: "Gratuity", voucher_no: String(doc.name),
        account: payable, debit: 0, credit: amount, against,
      });
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Gratuity"))} SET ${quoteIdent("status")} = 'Submitted'
         WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(`Gratuity ${doc.name}: provisioned ${amount} (Dr ${expense} / Cr ${payable})`);
    } catch (err) {
      this.logger.error(`Gratuity ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Gratuity")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Gratuity' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Gratuity"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
