import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const EMPLOYEE_ADVANCE = "Employee Advance";
const CASH = "Cash";

/**
 * Employee Advance accounting. Paying an advance moves cash into a receivable the
 * employee owes back: on submit it books Dr Employee Advance (asset) / Cr the
 * paid-from account (Cash/Bank) for the advance amount and marks it Paid; the
 * balance is later worked down by expense claims that adjust against it (see
 * ExpenseClaimListener). Cancel reverses the GL. Pure event-bus listener — HR
 * imports no other module's services.
 */
@Injectable()
export class EmployeeAdvanceListener {
  private readonly logger = new Logger(EmployeeAdvanceListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Employee Advance")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const adv = payload.doc;
    const glDt = this.registry.get("GL Entry");
    if (!glDt) return;
    const ctx = systemContext(payload.user);
    const amount = Number(adv.advance_amount ?? 0);
    if (amount <= 0) return;
    const advanceAccount = String(adv.advance_account || EMPLOYEE_ADVANCE);
    const paidFrom = String(adv.paid_from || CASH);
    const against = String(adv.employee ?? "");

    try {
      await this.documents.create(glDt, ctx, {
        posting_date: adv.posting_date ?? null, voucher_type: "Employee Advance",
        voucher_no: String(adv.name), account: advanceAccount, debit: amount, credit: 0, against,
      });
      await this.documents.create(glDt, ctx, {
        posting_date: adv.posting_date ?? null, voucher_type: "Employee Advance",
        voucher_no: String(adv.name), account: paidFrom, debit: 0, credit: amount, against,
      });
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Employee Advance"))}
         SET ${quoteIdent("status")} = 'Paid', ${quoteIdent("claimed_amount")} = coalesce(${quoteIdent("claimed_amount")}, 0)
         WHERE ${quoteIdent("name")} = $1`,
        [String(adv.name)],
      );
      this.logger.log(`Employee Advance ${adv.name}: paid ${amount} to ${against} (Dr ${advanceAccount} / Cr ${paidFrom})`);
    } catch (err) {
      this.logger.error(`Employee Advance ${adv.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Employee Advance")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = 'Employee Advance' AND ${quoteIdent("voucher_no")} = $1`,
        [String(payload.doc.name)],
      );
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Employee Advance"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
