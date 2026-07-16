import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import { HrService } from "./hr.service";

const EXPENSE = "Salary Expense";
const PAYABLE = "Salaries Payable";

/**
 * Leave encashment. Employees convert unused leave into a payout: the encashed
 * days are capped at the current balance for the leave type, and consume it
 * (HrService counts submitted encashments against the balance). On submit the
 * payout is booked Dr Salary Expense / Cr Salaries Payable; cancel reverses it.
 * The balance gate throws so a submit for more than the balance is aborted.
 */
@Injectable()
export class LeaveEncashmentListener {
  private readonly logger = new Logger(LeaveEncashmentListener.name);

  constructor(
    private readonly hr: HrService,
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so an over-encashment aborts the submit.
  @OnEvent("doc.before_submit:Leave Encashment", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const days = Number(doc.encashment_days ?? 0);
    if (days <= 0) throw new BadRequestException("Encashment Days must be positive");
    const employee = String(doc.employee ?? "");
    const leaveType = String(doc.leave_type ?? "");
    if (!employee || !leaveType) return;
    // balanceFor already nets off submitted encashments; this draft is not yet
    // submitted, so its own days are not double-counted.
    const balance = await this.hr.balanceFor(employee, leaveType);
    if (days > balance + 0.0001) {
      throw new BadRequestException(
        `Cannot encash ${days} ${leaveType} day(s) for ${employee}: balance is ${balance}`,
      );
    }
    this.logger.log(`Leave Encashment ${doc.name}: ${days} ${leaveType} day(s) within balance ${balance}`);
  }

  @OnEvent("doc.on_submit:Leave Encashment")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = Number(doc.encashment_amount ?? 0);
    const glDt = this.registry.get("GL Entry");
    if (!glDt || amount <= 0) return;
    const ctx = systemContext(payload.user);
    const expense = String(doc.expense_account ?? EXPENSE);
    const payable = String(doc.payable_account ?? PAYABLE);
    try {
      for (const line of [
        { account: expense, debit: amount, credit: 0 },
        { account: payable, debit: 0, credit: amount },
      ]) {
        await this.documents.create(glDt, ctx, {
          posting_date: doc.posting_date ?? null,
          voucher_type: "Leave Encashment",
          voucher_no: String(doc.name),
          account: line.account,
          debit: line.debit,
          credit: line.credit,
          against: String(doc.employee ?? ""),
        });
      }
      this.logger.log(`Leave Encashment ${doc.name}: Dr ${expense} / Cr ${payable} ${amount}`);
    } catch (err) {
      this.logger.error(`Leave Encashment ${doc.name} GL failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Leave Encashment")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Leave Encashment' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
