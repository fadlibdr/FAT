import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const SALARY_EXPENSE = "Salary Expense";
const SALARIES_PAYABLE = "Salaries Payable";

interface Component {
  account: string;
  amount: number;
}

/**
 * Payroll accounting. A submitted Salary Slip reads its Salary Structure's
 * earnings/deductions, computes gross / total deduction / net pay, and books a
 * balanced journal: Dr each earning account (Σ = gross), Cr each deduction
 * account (Σ = deductions) and Cr the payable account (net pay). Cancel reverses
 * the GL and zeroes the slip. Pure event-bus listener — Payroll imports no other
 * module's services.
 */
@Injectable()
export class PayrollListener {
  private readonly logger = new Logger(PayrollListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async setSlip(name: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Salary Slip"))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  /**
   * Attendance-based payment factor for a slip's period. Counts Attendance rows
   * in [start_date, end_date] (Present/On Leave = 1 day, Half Day = 0.5, Absent =
   * 0) and divides by total_working_days. Returns { factor, paymentDays }. When
   * the period/working-days are unset, or attendance simply isn't tracked for the
   * period, it defaults to full pay (factor 1) rather than zeroing the salary.
   */
  private async paymentFactor(
    slip: Record<string, unknown>,
  ): Promise<{ factor: number; paymentDays: number | null }> {
    const totalDays = Number(slip.total_working_days ?? 0);
    if (!slip.start_date || !slip.end_date || totalDays <= 0 || !this.registry.has("Attendance")) {
      return { factor: 1, paymentDays: null };
    }
    const start = new Date(slip.start_date as string).toISOString().slice(0, 10);
    const end = new Date(slip.end_date as string).toISOString().slice(0, 10);
    const row = (
      await this.dataSource.query(
        `SELECT
           count(*) AS n,
           coalesce(sum(CASE ${quoteIdent("status")}
             WHEN 'Present' THEN 1 WHEN 'On Leave' THEN 1 WHEN 'Half Day' THEN 0.5 ELSE 0 END), 0) AS paid
         FROM ${quoteIdent(tableNameFor("Attendance"))}
         WHERE ${quoteIdent("employee")} = $1
           AND ${quoteIdent("attendance_date")} >= $2 AND ${quoteIdent("attendance_date")} <= $3`,
        [String(slip.employee ?? ""), start, end],
      )
    )[0];
    // No attendance marked for the period → treat as fully worked.
    const paymentDays = Number(row?.n ?? 0) > 0 ? Number(row.paid) : totalDays;
    const factor = Math.min(paymentDays / totalDays, 1);
    return { factor, paymentDays };
  }

  /** Resolve each structure line to a GL account (component's own, else fallback). */
  private async resolve(
    rows: Array<Record<string, unknown>>,
    fallback: string,
  ): Promise<Component[]> {
    const compDt = this.registry.get("Salary Component");
    const out: Component[] = [];
    for (const r of rows ?? []) {
      const amount = Number(r.amount ?? 0);
      if (!amount) continue;
      let account = fallback;
      if (compDt) {
        try {
          const comp = await this.documents.get(compDt, String(r.salary_component));
          if (comp?.gl_account) account = String(comp.gl_account);
        } catch {
          /* component missing — fall back */
        }
      }
      out.push({ account, amount });
    }
    return out;
  }

  @OnEvent("doc.on_submit:Salary Slip")
  async onSalarySlipSubmit(payload: DocEventPayload): Promise<void> {
    const slip = payload.doc;
    const structDt = this.registry.get("Salary Structure");
    const glDt = this.registry.get("GL Entry");
    if (!structDt || !glDt) return;
    const ctx = systemContext(payload.user);

    try {
      const struct = await this.documents.get(structDt, String(slip.salary_structure));
      const earnings = await this.resolve(
        (struct.earnings as Array<Record<string, unknown>>) ?? [],
        SALARY_EXPENSE,
      );
      const deductions = await this.resolve(
        (struct.deductions as Array<Record<string, unknown>>) ?? [],
        SALARIES_PAYABLE,
      );

      // Loss-of-pay proration: scale earnings by attendance days / working days.
      const { factor, paymentDays } = await this.paymentFactor(slip);
      if (factor < 1) for (const e of earnings) e.amount = e.amount * factor;

      const gross = earnings.reduce((s, e) => s + e.amount, 0);
      const totalDeduction = deductions.reduce((s, d) => s + d.amount, 0);
      const net = gross - totalDeduction;
      const payable = String(slip.payable_account ?? SALARIES_PAYABLE);

      // Dr earnings (expense), Cr deductions, Cr net pay to the payable account.
      const lines: Array<{ account: string; debit: number; credit: number }> = [];
      for (const e of earnings) lines.push({ account: e.account, debit: e.amount, credit: 0 });
      for (const d of deductions) lines.push({ account: d.account, debit: 0, credit: d.amount });
      if (net !== 0) lines.push({ account: payable, debit: 0, credit: net });

      for (const line of lines) {
        await this.documents.create(glDt, ctx, {
          posting_date: slip.posting_date ?? null,
          voucher_type: "Salary Slip",
          voucher_no: slip.name,
          account: line.account,
          debit: line.debit,
          credit: line.credit,
          against: String(slip.employee ?? ""),
        });
      }

      await this.setSlip(String(slip.name), {
        gross_pay: gross,
        total_deduction: totalDeduction,
        net_pay: net,
        payment_days: paymentDays,
        status: "Submitted",
      });
      this.logger.log(
        `Salary Slip ${slip.name}: gross ${gross} - ded ${totalDeduction} = net ${net}` +
          `${paymentDays != null ? ` (payment days ${paymentDays})` : ""} (${slip.employee})`,
      );
    } catch (err) {
      this.logger.error(`Salary Slip ${slip.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Salary Slip")
  async onSalarySlipCancel(payload: DocEventPayload): Promise<void> {
    const slip = payload.doc;
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
        ["Salary Slip", slip.name],
      );
    }
    await this.setSlip(String(slip.name), { status: "Cancelled" });
  }
}
