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

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Employee loans. A loan disburses cash up front and amortises over its tenure
 * with equal monthly principal and interest charged on the reducing balance.
 * Pure event-bus listener — no cross-module service imports.
 *
 *  1. before_save builds the repayment schedule (equal principal + reducing-balance
 *     interest) and rolls up the total interest/payable.
 *  2. on_submit books Dr Employee Loan (asset) / Cr Cash for the disbursement and
 *     marks the loan Disbursed.
 *  3. on_cancel reverses the GL.
 */
@Injectable()
export class LoanListener {
  private readonly logger = new Logger(LoanListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Loan")
  onSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    const existing = (d.schedule as Array<Record<string, unknown>>) ?? [];
    if (existing.length > 0) return; // keep an explicit schedule as-is
    const amount = Number(d.loan_amount ?? 0);
    const months = Math.max(1, Math.trunc(Number(d.tenure_months ?? 0)));
    if (!amount || !d.disbursement_date) return;
    const monthlyRate = Number(d.interest_rate ?? 0) / 12 / 100;
    const principalPer = round2(amount / months);

    const rows: Array<Record<string, unknown>> = [];
    let balance = amount;
    let totalInterest = 0;
    for (let i = 0; i < months; i += 1) {
      // Last row absorbs any rounding remainder so the loan closes at exactly zero.
      const principal = i === months - 1 ? round2(balance) : principalPer;
      const interest = round2(balance * monthlyRate);
      balance = round2(balance - principal);
      totalInterest += interest;
      rows.push({
        due_date: addMonths(d.disbursement_date, i + 1),
        principal,
        interest,
        total_payment: round2(principal + interest),
        balance: balance < 0 ? 0 : balance,
      });
    }
    d.schedule = rows;
    d.total_interest = round2(totalInterest);
    d.total_payable = round2(amount + totalInterest);
  }

  @OnEvent("doc.on_submit:Loan")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const amount = Number(doc.loan_amount ?? 0);
    const loanAccount = String(doc.loan_account || "Employee Loan");
    const cash = String(doc.disbursed_from || "Cash");
    const against = String(doc.employee ?? "");
    try {
      await this.documents.create(dt, ctx, {
        posting_date: doc.disbursement_date ?? null, voucher_type: "Loan",
        voucher_no: String(doc.name), account: loanAccount, debit: amount, credit: 0, against,
      });
      await this.documents.create(dt, ctx, {
        posting_date: doc.disbursement_date ?? null, voucher_type: "Loan",
        voucher_no: String(doc.name), account: cash, debit: 0, credit: amount, against,
      });
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Loan"))} SET ${quoteIdent("status")} = 'Disbursed'
         WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(`Loan ${doc.name}: disbursed ${amount} (Dr ${loanAccount} / Cr ${cash})`);
    } catch (err) {
      this.logger.error(`Loan ${doc.name} disbursement failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Loan")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Loan' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Loan"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
