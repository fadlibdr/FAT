import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Batch payroll run. Submitting a Payroll Entry generates and submits one Salary
 * Slip per active employee (of the chosen company) using the entry's salary
 * structure — each slip then computes its own gross/net and posts GL through the
 * existing PayrollListener. Cancelling the entry cascades: every slip it produced
 * is cancelled (reversing its GL). Creates/cancels slips through the generic
 * DocumentService, so Payroll imports no other module's services.
 */
@Injectable()
export class PayrollEntryListener {
  private readonly logger = new Logger(PayrollEntryListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Payroll Entry")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const slipDt = this.registry.get("Salary Slip");
    if (!slipDt || !this.registry.has("Employee")) return;
    const ctx = systemContext(payload.user);

    // Active employees, optionally scoped to the entry's company.
    const params: unknown[] = [];
    let where = `coalesce(${quoteIdent("status")}, 'Active') <> 'Left'`;
    if (doc.company) {
      params.push(String(doc.company));
      where += ` AND ${quoteIdent("company")} = $${params.length}`;
    }
    const employees: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Employee"))} WHERE ${where}`,
      params,
    );

    // Nominal net per structure (Σ earnings − Σ deductions). Used for the entry's
    // headline total: the slip on_submit hook that computes each net_pay is
    // fire-and-forget, so the persisted per-slip figure is not readable here.
    const structureNet = await this.structureNet(String(doc.salary_structure ?? ""));

    let count = 0;
    for (const emp of employees) {
      try {
        const slip = await this.documents.create(slipDt, ctx, {
          employee: String(emp.name),
          salary_structure: doc.salary_structure,
          payroll_entry: String(doc.name),
          company: doc.company ?? null,
          posting_date: doc.posting_date ?? null,
          start_date: doc.start_date ?? null,
          end_date: doc.end_date ?? null,
          total_working_days: Number(doc.total_working_days ?? 0) || null,
          payable_account: doc.payable_account ?? "Salaries Payable",
        });
        await this.documents.setDocStatus(slipDt, ctx, String(slip.name), 1);
        count += 1;
      } catch (err) {
        this.logger.error(`Payroll Entry ${doc.name}: slip for ${emp.name} failed: ${(err as Error).message}`);
      }
    }
    const totalNet = structureNet * count;

    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Payroll Entry"))}
       SET ${quoteIdent("employees_paid")} = $1, ${quoteIdent("total_net_pay")} = $2,
           ${quoteIdent("status")} = 'Submitted'
       WHERE ${quoteIdent("name")} = $3`,
      [count, round2(totalNet), String(doc.name)],
    );
    this.logger.log(`Payroll Entry ${doc.name}: paid ${count} employees, net ${round2(totalNet)}`);
  }

  /** Nominal net (Σ earnings − Σ deductions) for a salary structure. */
  private async structureNet(structure: string): Promise<number> {
    if (!structure || !this.registry.has("Salary Detail")) return 0;
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("parentfield")} AS pf, coalesce(sum(${quoteIdent("amount")}), 0) AS total
       FROM ${quoteIdent(tableNameFor("Salary Detail"))} WHERE ${quoteIdent("parent")} = $1
       GROUP BY ${quoteIdent("parentfield")}`,
      [structure],
    );
    let earnings = 0;
    let deductions = 0;
    for (const r of rows) {
      if (String(r.pf) === "earnings") earnings = Number(r.total ?? 0);
      else if (String(r.pf) === "deductions") deductions = Number(r.total ?? 0);
    }
    return round2(earnings - deductions);
  }

  @OnEvent("doc.on_cancel:Payroll Entry")
  async onCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const slipDt = this.registry.get("Salary Slip");
    if (!slipDt) return;
    const ctx = systemContext(payload.user);
    const slips: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Salary Slip"))}
       WHERE ${quoteIdent("payroll_entry")} = $1 AND ${quoteIdent("docstatus")} = 1`,
      [String(doc.name)],
    );
    for (const s of slips) {
      try {
        await this.documents.setDocStatus(slipDt, ctx, String(s.name), 2);
      } catch (err) {
        this.logger.error(`Payroll Entry ${doc.name}: cancel slip ${s.name} failed: ${(err as Error).message}`);
      }
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Payroll Entry"))}
       SET ${quoteIdent("status")} = 'Cancelled', ${quoteIdent("employees_paid")} = 0,
           ${quoteIdent("total_net_pay")} = 0
       WHERE ${quoteIdent("name")} = $1`,
      [String(doc.name)],
    );
    this.logger.log(`Payroll Entry ${doc.name}: cancelled ${slips.length} slips`);
  }
}
