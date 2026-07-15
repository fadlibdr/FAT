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
 * Employee full-and-final settlement. On the way out, an employee's unused leave
 * is encashed and combined with any other earnings less deductions into a net
 * payable, which is booked as a salary expense against a payable and the employee
 * marked Left. Pure event-bus listener, no cross-module service imports.
 *
 *  1. before_save reads the employee's net leave balance (submitted allocations −
 *     submitted applications), encashes it at the per-day rate, and computes the
 *     net payable.
 *  2. on_submit books Dr Salary Expense / Cr Salaries Payable and flips the
 *     employee to Left; on_cancel reverses the GL.
 */
@Injectable()
export class FinalSettlementListener {
  private readonly logger = new Logger(FinalSettlementListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async leaveBalance(employee: string): Promise<number> {
    if (!this.registry.has("Leave Allocation")) return 0;
    const alloc = Number(
      (
        await this.dataSource.query(
          `SELECT coalesce(sum(${quoteIdent("new_leaves_allocated")}), 0) AS a
           FROM ${quoteIdent(tableNameFor("Leave Allocation"))}
           WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("docstatus")} = 1`,
          [employee],
        )
      )[0]?.a ?? 0,
    );
    const used = this.registry.has("Leave Application")
      ? Number(
          (
            await this.dataSource.query(
              `SELECT coalesce(sum(${quoteIdent("total_leave_days")}), 0) AS u
               FROM ${quoteIdent(tableNameFor("Leave Application"))}
               WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("docstatus")} = 1`,
              [employee],
            )
          )[0]?.u ?? 0,
        )
      : 0;
    return Math.max(0, alloc - used);
  }

  @OnEvent("doc.before_save:Full and Final Statement")
  async onSave(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    const employee = String(d.employee ?? "");
    if (!employee) return;
    const balance = await this.leaveBalance(employee);
    const rate = Number(d.per_day_rate ?? 0);
    const encash = round2(balance * rate);
    d.leave_balance = balance;
    d.leave_encashment = encash;
    d.net_payable = round2(encash + Number(d.other_earnings ?? 0) - Number(d.deductions ?? 0));
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Full and Final Statement", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const doc = payload.doc;
    if (!doc.employee) throw new BadRequestException("An employee is required");
    if (Number(doc.net_payable ?? 0) < 0) {
      throw new BadRequestException(
        `Full and Final Statement ${doc.name}: net payable ${doc.net_payable} cannot be negative`,
      );
    }
  }

  @OnEvent("doc.on_submit:Full and Final Statement")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const amount = Number(doc.net_payable ?? 0);
    const against = String(doc.employee ?? "");
    const postingDate = doc.relieving_date ?? null;
    try {
      if (amount > 0) {
        await this.documents.create(dt, ctx, {
          posting_date: postingDate, voucher_type: "Full and Final Statement", voucher_no: String(doc.name),
          account: "Salary Expense", debit: amount, credit: 0, against,
        });
        await this.documents.create(dt, ctx, {
          posting_date: postingDate, voucher_type: "Full and Final Statement", voucher_no: String(doc.name),
          account: "Salaries Payable", debit: 0, credit: amount, against,
        });
      }
      if (this.registry.has("Employee")) {
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Employee"))} SET ${quoteIdent("status")} = 'Left'
           WHERE ${quoteIdent("name")} = $1`,
          [against],
        );
      }
      this.logger.log(`Full and Final Statement ${doc.name}: settled ${amount} for ${against} (marked Left)`);
    } catch (err) {
      this.logger.error(`Full and Final Statement ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Full and Final Statement")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Full and Final Statement' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
