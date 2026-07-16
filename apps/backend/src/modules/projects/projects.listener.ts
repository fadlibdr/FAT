import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Rolls submitted Timesheets up onto their Project: total hours, the billable
 * amount (hours × billing rate on billable lines), and the labour cost (hours ×
 * costing rate, on every line). The project's gross margin = billable − cost is
 * kept current after each roll, and cancel unwinds the contribution. Pure
 * event-bus listener — Projects imports no other module's services.
 */
@Injectable()
export class ProjectsListener {
  private readonly logger = new Logger(ProjectsListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private billable(doc: Record<string, unknown>): number {
    const isBillable = Number(doc.is_billable ?? 0) === 1;
    return isBillable ? Number(doc.hours ?? 0) * Number(doc.billing_rate ?? 0) : 0;
  }

  /** Labour cost of a timesheet: hours × costing rate (regardless of billability). */
  private costing(doc: Record<string, unknown>): number {
    return Number(doc.hours ?? 0) * Number(doc.costing_rate ?? 0);
  }

  /** Add (sign +1) or remove (sign -1) a timesheet's contribution to its project. */
  private async rollup(project: string, hours: number, billable: number, costing: number, sign: number): Promise<void> {
    if (!project || !this.registry.has("Project")) return;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Project"))}
       SET ${quoteIdent("total_hours")} = coalesce(${quoteIdent("total_hours")},0) + $1,
           ${quoteIdent("total_billable_amount")} = coalesce(${quoteIdent("total_billable_amount")},0) + $2,
           ${quoteIdent("total_costing_amount")} = coalesce(${quoteIdent("total_costing_amount")},0) + $3,
           ${quoteIdent("gross_margin")} =
             coalesce(${quoteIdent("total_billable_amount")},0) + $2
             - (coalesce(${quoteIdent("total_costing_amount")},0) + $3)
       WHERE ${quoteIdent("name")} = $4`,
      [sign * hours, sign * billable, sign * costing, project],
    );
  }

  // suppressErrors:false so a negative-value timesheet aborts the submit.
  @OnEvent("doc.before_submit:Timesheet", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const doc = payload.doc;
    if (Number(doc.hours ?? 0) < 0) throw new BadRequestException("Timesheet hours cannot be negative");
    if (Number(doc.billing_rate ?? 0) < 0) throw new BadRequestException("Billing rate cannot be negative");
    if (Number(doc.costing_rate ?? 0) < 0) throw new BadRequestException("Costing rate cannot be negative");
  }

  @OnEvent("doc.on_submit:Timesheet")
  async onTimesheetSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = this.billable(doc);
    const cost = this.costing(doc);
    if (this.registry.has("Timesheet")) {
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Timesheet"))}
         SET ${quoteIdent("billable_amount")} = $1, ${quoteIdent("costing_amount")} = $2
         WHERE ${quoteIdent("name")} = $3`,
        [amount, cost, doc.name],
      );
    }
    await this.rollup(String(doc.project ?? ""), Number(doc.hours ?? 0), amount, cost, +1);
    this.logger.log(`Timesheet ${doc.name}: +${doc.hours}h / bill ${amount} / cost ${cost} -> ${doc.project}`);
  }

  @OnEvent("doc.on_cancel:Timesheet")
  async onTimesheetCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    await this.rollup(String(doc.project ?? ""), Number(doc.hours ?? 0), this.billable(doc), this.costing(doc), -1);
  }
}
