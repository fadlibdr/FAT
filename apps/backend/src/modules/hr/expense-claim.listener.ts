import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const EMPLOYEE_EXPENSE = "Employee Expense";
const EMPLOYEE_PAYABLE = "Employee Payable";
const EMPLOYEE_ADVANCE = "Employee Advance";

interface AdvanceRow {
  name: string;
  employee: string;
  advance_account: string;
  advance_amount: number;
  claimed_amount: number;
  status: string;
}

/**
 * Expense Claim accounting. A submitted Expense Claim books a balanced journal:
 * Dr each expense line to its account (the line's own, else a general employee
 * expense account) and Cr the claim to the employee payable account.
 *
 * When the claim is linked to an Employee Advance, the credit is split: the part
 * covered by the advance's remaining balance is credited to the advance account
 * (working the receivable down, not increasing the payable), and only the excess
 * is credited to the payable. A before_submit gate blocks a claim adjusting
 * against an advance of a different employee or one with no balance left.
 *
 * Cancel reverses the GL, unwinds any advance adjustment, and marks the claim
 * cancelled. Pure event-bus listener — HR imports no other module's services.
 */
@Injectable()
export class ExpenseClaimListener {
  private readonly logger = new Logger(ExpenseClaimListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async setClaim(name: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Expense Claim"))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  private async loadAdvance(name: string): Promise<AdvanceRow | null> {
    if (!name || !this.registry.has("Employee Advance")) return null;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("employee")} AS employee,
                ${quoteIdent("advance_account")} AS advance_account, ${quoteIdent("advance_amount")} AS advance_amount,
                coalesce(${quoteIdent("claimed_amount")}, 0) AS claimed_amount, ${quoteIdent("status")} AS status
         FROM ${quoteIdent(tableNameFor("Employee Advance"))} WHERE ${quoteIdent("name")} = $1 LIMIT 1`,
        [name],
      )
    )[0];
    if (!row) return null;
    return {
      name: String(row.name), employee: String(row.employee ?? ""),
      advance_account: String(row.advance_account || EMPLOYEE_ADVANCE),
      advance_amount: Number(row.advance_amount ?? 0), claimed_amount: Number(row.claimed_amount ?? 0),
      status: String(row.status ?? ""),
    };
  }

  // suppressErrors:false so the advance-validation gate can abort the submit.
  @OnEvent("doc.before_submit:Expense Claim", { suppressErrors: false })
  async onBeforeSubmit(payload: DocEventPayload): Promise<void> {
    const claim = payload.doc;
    const advanceName = String(claim.advance ?? "");
    if (!advanceName) return;
    const adv = await this.loadAdvance(advanceName);
    if (!adv) throw new BadRequestException(`Advance ${advanceName} not found`);
    if (adv.status !== "Paid" && adv.status !== "Claimed") {
      throw new BadRequestException(`Advance ${advanceName} is not paid (status ${adv.status})`);
    }
    if (adv.employee !== String(claim.employee ?? "")) {
      throw new BadRequestException(`Advance ${advanceName} belongs to a different employee`);
    }
    if (adv.advance_amount - adv.claimed_amount <= 0.0001) {
      throw new BadRequestException(`Advance ${advanceName} has no balance left to adjust`);
    }
  }

  @OnEvent("doc.on_submit:Expense Claim")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const claim = payload.doc;
    const glDt = this.registry.get("GL Entry");
    if (!glDt) return;
    const ctx = systemContext(payload.user);
    const against = String(claim.employee ?? "");
    const payable = String(claim.payable_account || EMPLOYEE_PAYABLE);

    try {
      const lines: Array<{ account: string; debit: number; credit: number }> = [];
      let total = 0;
      for (const row of (claim.expenses as Array<Record<string, unknown>>) ?? []) {
        const amount = Number(row.amount ?? 0);
        if (!amount) continue;
        total += amount;
        lines.push({ account: String(row.default_account || EMPLOYEE_EXPENSE), debit: amount, credit: 0 });
      }
      if (total === 0) return;

      // Split the credit between the linked advance's remaining balance and the payable.
      const adv = await this.loadAdvance(String(claim.advance ?? ""));
      const adjusted = adv ? Math.min(total, Math.round((adv.advance_amount - adv.claimed_amount) * 100) / 100) : 0;
      if (adv && adjusted > 0) {
        lines.push({ account: adv.advance_account, debit: 0, credit: adjusted });
      }
      if (total - adjusted > 0.0001) {
        lines.push({ account: payable, debit: 0, credit: Math.round((total - adjusted) * 100) / 100 });
      }

      for (const l of lines) {
        await this.documents.create(glDt, ctx, {
          posting_date: claim.posting_date ?? null,
          voucher_type: "Expense Claim",
          voucher_no: claim.name,
          account: l.account,
          debit: l.debit,
          credit: l.credit,
          against,
        });
      }
      await this.setClaim(String(claim.name), { total_claimed: total, advance_adjusted: adjusted, status: "Submitted" });

      // Work the advance's claimed balance up; complete it when fully consumed.
      if (adv && adjusted > 0) {
        const newClaimed = Math.round((adv.claimed_amount + adjusted) * 100) / 100;
        const done = newClaimed >= adv.advance_amount - 0.0001;
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Employee Advance"))}
           SET ${quoteIdent("claimed_amount")} = $1, ${quoteIdent("status")} = $2 WHERE ${quoteIdent("name")} = $3`,
          [newClaimed, done ? "Claimed" : "Paid", adv.name],
        );
      }
      this.logger.log(
        `Expense Claim ${claim.name}: posted ${total} for ${against}` +
          (adjusted > 0 ? ` (adjusted ${adjusted} vs advance ${adv?.name})` : ""),
      );
    } catch (err) {
      this.logger.error(`Expense Claim ${claim.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Expense Claim")
  async onCancel(payload: DocEventPayload): Promise<void> {
    const claim = payload.doc;
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
        ["Expense Claim", claim.name],
      );
    }
    // Unwind any advance adjustment this claim made.
    const adjusted = Number(claim.advance_adjusted ?? 0);
    const adv = await this.loadAdvance(String(claim.advance ?? ""));
    if (adv && adjusted > 0) {
      const newClaimed = Math.max(0, Math.round((adv.claimed_amount - adjusted) * 100) / 100);
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Employee Advance"))}
         SET ${quoteIdent("claimed_amount")} = $1, ${quoteIdent("status")} = 'Paid' WHERE ${quoteIdent("name")} = $2`,
        [newClaimed, adv.name],
      );
    }
    await this.setClaim(String(claim.name), { status: "Cancelled" });
  }
}
