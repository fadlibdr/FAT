import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const EMPLOYEE_EXPENSE = "Employee Expense";
const EMPLOYEE_PAYABLE = "Employee Payable";

/**
 * Expense Claim accounting. A submitted Expense Claim books a balanced journal:
 * Dr each expense line to its account (the line's own, else a general employee
 * expense account) and Cr the total to the employee payable account. Cancel
 * reverses the GL and marks the claim cancelled. Pure event-bus listener — HR
 * imports no other module's services.
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
      lines.push({ account: payable, debit: 0, credit: total });

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
      await this.setClaim(String(claim.name), { total_claimed: total, status: "Submitted" });
      this.logger.log(`Expense Claim ${claim.name}: posted ${total} for ${against}`);
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
    await this.setClaim(String(claim.name), { status: "Cancelled" });
  }
}
