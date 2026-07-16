import { BadRequestException, Injectable, Logger } from "@nestjs/common";
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
 * Employee Advance Return: an employee hands back the unspent part of an advance.
 * It is the mirror of paying the advance — on submit it books Dr Cash (or the
 * chosen account) / Cr Employee Advance for the returned amount, shrinking the
 * receivable, and rolls the returned figure onto the parent advance. When the
 * advance's paid amount is fully worked down (claims + returns), the advance is
 * marked Claimed. Cancel reverses both. A pre-submit gate keeps a return within
 * the advance's outstanding balance. Pure event-bus listener — no cross-module
 * service imports.
 */
@Injectable()
export class EmployeeAdvanceReturnListener {
  private readonly logger = new Logger(EmployeeAdvanceReturnListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** The advance row backing a return, or null if it does not exist / is not submitted. */
  private async advanceFor(name: string): Promise<{
    name: string; advance_amount: number; claimed_amount: number; returned_amount: number; docstatus: number;
  } | null> {
    if (!name || !this.registry.has(EMPLOYEE_ADVANCE)) return null;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name, coalesce(${quoteIdent("advance_amount")}, 0) AS advance_amount,
                coalesce(${quoteIdent("claimed_amount")}, 0) AS claimed_amount,
                coalesce(${quoteIdent("returned_amount")}, 0) AS returned_amount,
                ${quoteIdent("docstatus")} AS docstatus
         FROM ${quoteIdent(tableNameFor(EMPLOYEE_ADVANCE))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (!row) return null;
    return {
      name: String(row.name),
      advance_amount: Number(row.advance_amount),
      claimed_amount: Number(row.claimed_amount),
      returned_amount: Number(row.returned_amount),
      docstatus: Number(row.docstatus),
    };
  }

  // suppressErrors:false so an over-return or an unpaid advance aborts the submit.
  @OnEvent("doc.before_submit:Employee Advance Return", { suppressErrors: false })
  async onBeforeSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = Number(doc.return_amount ?? 0);
    if (amount <= 0) throw new BadRequestException("Return Amount must be greater than zero");
    const adv = await this.advanceFor(String(doc.employee_advance ?? ""));
    if (!adv) throw new BadRequestException(`Employee Advance ${doc.employee_advance} not found`);
    if (adv.docstatus !== 1) {
      throw new BadRequestException(`Employee Advance ${adv.name} is not submitted`);
    }
    const outstanding = adv.advance_amount - adv.claimed_amount - adv.returned_amount;
    if (amount > outstanding + 1e-6) {
      throw new BadRequestException(
        `Return ${amount} exceeds outstanding ${outstanding} on advance ${adv.name}`,
      );
    }
  }

  @OnEvent("doc.on_submit:Employee Advance Return")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const glDt = this.registry.get("GL Entry");
    const amount = Number(doc.return_amount ?? 0);
    if (!glDt || amount <= 0) return;
    const ctx = systemContext(payload.user);
    const returnTo = String(doc.return_to || CASH);
    const advanceAccount = String(doc.advance_account || EMPLOYEE_ADVANCE);
    const advanceName = String(doc.employee_advance ?? "");
    const against = String(doc.employee ?? "");

    try {
      await this.documents.create(glDt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Employee Advance Return",
        voucher_no: String(doc.name), account: returnTo, debit: amount, credit: 0, against,
      });
      await this.documents.create(glDt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Employee Advance Return",
        voucher_no: String(doc.name), account: advanceAccount, debit: 0, credit: amount, against,
      });
      await this.applyReturn(advanceName, amount);
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Employee Advance Return"))}
         SET ${quoteIdent("status")} = 'Submitted' WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(`Employee Advance Return ${doc.name}: returned ${amount} from ${against} (Dr ${returnTo} / Cr ${advanceAccount})`);
    } catch (err) {
      this.logger.error(`Employee Advance Return ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Employee Advance Return")
  async onCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = Number(doc.return_amount ?? 0);
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = 'Employee Advance Return' AND ${quoteIdent("voucher_no")} = $1`,
        [String(doc.name)],
      );
    }
    await this.applyReturn(String(doc.employee_advance ?? ""), -amount);
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Employee Advance Return"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [String(doc.name)],
    );
  }

  /** Roll a return delta onto the parent advance and re-derive its settled status. */
  private async applyReturn(advanceName: string, delta: number): Promise<void> {
    const adv = await this.advanceFor(advanceName);
    if (!adv) return;
    const returned = Math.max(0, adv.returned_amount + delta);
    const settled = returned + adv.claimed_amount >= adv.advance_amount - 1e-6;
    const status = adv.docstatus === 1 ? (settled ? "Claimed" : "Paid") : undefined;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(EMPLOYEE_ADVANCE))}
       SET ${quoteIdent("returned_amount")} = $2${status ? `, ${quoteIdent("status")} = $3` : ""}
       WHERE ${quoteIdent("name")} = $1`,
      status ? [advanceName, returned, status] : [advanceName, returned],
    );
  }
}
