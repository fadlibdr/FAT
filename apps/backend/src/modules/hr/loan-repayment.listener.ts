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
 * Loan repayment collection. Each repayment splits into a principal part (which
 * reduces the Employee Loan asset) and an interest part (booked to income). Pure
 * event-bus listener — no cross-module service imports.
 *
 *  1. before_save totals principal + interest.
 *  2. before_submit gates against over-repayment (principal already repaid plus
 *     this one may not exceed the loan's original amount) and a non-disbursed loan.
 *  3. on_submit posts Dr Cash / Cr Employee Loan (principal) / Cr Interest Income
 *     (interest), bumps the loan's repaid totals and closes it when fully repaid.
 *  4. on_cancel reverses the GL and unwinds the loan's repaid totals.
 */
@Injectable()
export class LoanRepaymentListener {
  private readonly logger = new Logger(LoanRepaymentListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async loan(name: string): Promise<Record<string, unknown> | undefined> {
    if (!name || !this.registry.has("Loan")) return undefined;
    return (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("employee")} AS employee,
                ${quoteIdent("loan_amount")} AS loan_amount, ${quoteIdent("docstatus")} AS docstatus,
                coalesce(${quoteIdent("repaid_principal")}, 0) AS repaid_principal,
                coalesce(${quoteIdent("interest_paid")}, 0) AS interest_paid
         FROM ${quoteIdent(tableNameFor("Loan"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
  }

  @OnEvent("doc.before_save:Loan Repayment Entry")
  onSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    d.total_amount = round2(Number(d.principal_amount ?? 0) + Number(d.interest_amount ?? 0));
  }

  // suppressErrors:false so the over-repayment gate aborts the submit.
  @OnEvent("doc.before_submit:Loan Repayment Entry", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const loan = await this.loan(String(doc.loan ?? ""));
    if (!loan) throw new BadRequestException(`Loan ${doc.loan} not found`);
    if (Number(loan.docstatus) !== 1) {
      throw new BadRequestException(`Loan ${doc.loan} is not disbursed`);
    }
    const principal = Number(doc.principal_amount ?? 0);
    const repaid = Number(loan.repaid_principal ?? 0);
    const total = Number(loan.loan_amount ?? 0);
    if (round2(repaid + principal) > round2(total) + 0.0001) {
      throw new BadRequestException(
        `Loan ${doc.loan}: repayment principal ${principal} exceeds outstanding ` +
          `${round2(total - repaid)} (loan ${total}, already repaid ${repaid})`,
      );
    }
  }

  @OnEvent("doc.on_submit:Loan Repayment Entry")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    const loan = await this.loan(String(doc.loan ?? ""));
    if (!dt || !loan) return;
    const ctx = systemContext(payload.user);
    const principal = Number(doc.principal_amount ?? 0);
    const interest = Number(doc.interest_amount ?? 0);
    const total = round2(principal + interest);
    const cash = String(doc.received_to || "Cash");
    const loanAccount = String(doc.loan_account || "Employee Loan");
    const interestAccount = String(doc.interest_account || "Interest Income");
    const against = String(loan.employee ?? "");
    try {
      await this.post(dt, ctx, doc, cash, total, 0, against);
      await this.post(dt, ctx, doc, loanAccount, 0, principal, against);
      await this.post(dt, ctx, doc, interestAccount, 0, interest, against);

      const newRepaid = round2(Number(loan.repaid_principal ?? 0) + principal);
      const newInterest = round2(Number(loan.interest_paid ?? 0) + interest);
      const closed = newRepaid >= Number(loan.loan_amount ?? 0) - 0.0001;
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Loan"))}
         SET ${quoteIdent("repaid_principal")} = $1, ${quoteIdent("interest_paid")} = $2,
             ${quoteIdent("status")} = $3
         WHERE ${quoteIdent("name")} = $4`,
        [newRepaid, newInterest, closed ? "Closed" : "Disbursed", String(loan.name)],
      );
      this.logger.log(
        `Loan Repayment ${doc.name}: Dr ${cash} ${total} / Cr ${loanAccount} ${principal} / Cr ${interestAccount} ${interest}`,
      );
    } catch (err) {
      this.logger.error(`Loan Repayment ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Loan Repayment Entry")
  async onCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = 'Loan Repayment Entry' AND ${quoteIdent("voucher_no")} = $1`,
        [String(doc.name)],
      );
    }
    const loan = await this.loan(String(doc.loan ?? ""));
    if (!loan) return;
    const newRepaid = round2(Number(loan.repaid_principal ?? 0) - Number(doc.principal_amount ?? 0));
    const newInterest = round2(Number(loan.interest_paid ?? 0) - Number(doc.interest_amount ?? 0));
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Loan"))}
       SET ${quoteIdent("repaid_principal")} = $1, ${quoteIdent("interest_paid")} = $2,
           ${quoteIdent("status")} = 'Disbursed'
       WHERE ${quoteIdent("name")} = $3`,
      [newRepaid < 0 ? 0 : newRepaid, newInterest < 0 ? 0 : newInterest, String(loan.name)],
    );
  }

  private async post(
    dt: ReturnType<DoctypeRegistryService["get"]>,
    ctx: ReturnType<typeof systemContext>,
    doc: Record<string, unknown>,
    account: string,
    debit: number,
    credit: number,
    against: string,
  ): Promise<void> {
    if (!dt || (!debit && !credit)) return;
    await this.documents.create(dt, ctx, {
      posting_date: doc.posting_date ?? null,
      voucher_type: "Loan Repayment Entry",
      voucher_no: String(doc.name),
      account,
      debit,
      credit,
      against,
    });
  }
}
