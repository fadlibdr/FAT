import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Rolls submitted Timesheets up onto their Project: total hours and (for billable
 * lines) the billable amount = hours × billing rate. Cancel unwinds the rollup.
 * Pure event-bus listener — Projects imports no other module's services.
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

  /** Add (sign +1) or remove (sign -1) a timesheet's contribution to its project. */
  private async rollup(project: string, hours: number, amount: number, sign: number): Promise<void> {
    if (!project || !this.registry.has("Project")) return;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Project"))}
       SET ${quoteIdent("total_hours")} = coalesce(${quoteIdent("total_hours")},0) + $1,
           ${quoteIdent("total_billable_amount")} = coalesce(${quoteIdent("total_billable_amount")},0) + $2
       WHERE ${quoteIdent("name")} = $3`,
      [sign * hours, sign * amount, project],
    );
  }

  @OnEvent("doc.on_submit:Timesheet")
  async onTimesheetSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = this.billable(doc);
    if (this.registry.has("Timesheet")) {
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Timesheet"))} SET ${quoteIdent("billable_amount")} = $1
         WHERE ${quoteIdent("name")} = $2`,
        [amount, doc.name],
      );
    }
    await this.rollup(String(doc.project ?? ""), Number(doc.hours ?? 0), amount, +1);
    this.logger.log(`Timesheet ${doc.name}: +${doc.hours}h / ${amount} -> ${doc.project}`);
  }

  @OnEvent("doc.on_cancel:Timesheet")
  async onTimesheetCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    await this.rollup(String(doc.project ?? ""), Number(doc.hours ?? 0), this.billable(doc), -1);
  }
}
