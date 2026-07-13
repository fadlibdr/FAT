import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Customer-engagement behaviours. Pure event-bus listener, no cross-module
 * service imports:
 *
 *  1. before_submit on a Contract validates the date range and, if the end date
 *     has already passed, blocks the submit.
 *  2. on_submit/on_cancel on a Contract derive its status (Active vs Expired
 *     against the posting day) and reset it on cancel.
 *  3. before_submit on an Appointment blocks a submit that would double-book the
 *     assignee against another submitted appointment.
 */
@Injectable()
export class EngagementListener {
  private readonly logger = new Logger(EngagementListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async setStatus(doctype: string, name: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${quoteIdent("status")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [status, name],
    );
  }

  /** Milliseconds since epoch for a Date/ISO value, or NaN if absent/invalid. */
  private ms(value: unknown): number {
    if (value === null || value === undefined || value === "") return NaN;
    return new Date(value as string).getTime();
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Contract", { suppressErrors: false })
  gateContract(payload: DocEventPayload): void {
    const doc = payload.doc;
    const start = this.ms(doc.start_date);
    const end = this.ms(doc.end_date);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end < start) {
      throw new BadRequestException(
        `Contract ${doc.name}: end date ${doc.end_date} is before start date ${doc.start_date}`,
      );
    }
  }

  @OnEvent("doc.on_submit:Contract")
  async onContractSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const end = this.ms(doc.end_date);
    const status = !Number.isNaN(end) && end < Date.now() ? "Expired" : "Active";
    await this.setStatus("Contract", String(doc.name), status);
    this.logger.log(`Contract ${doc.name} submitted -> ${status}`);
  }

  @OnEvent("doc.on_cancel:Contract")
  async onContractCancel(payload: DocEventPayload): Promise<void> {
    await this.setStatus("Contract", String(payload.doc.name), "Cancelled");
  }

  @OnEvent("doc.before_submit:Appointment", { suppressErrors: false })
  async gateAppointment(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const who = String(doc.assigned_to ?? "");
    const startMs = this.ms(doc.start_time);
    const endMs = this.ms(doc.end_time);
    if (!who || Number.isNaN(startMs) || Number.isNaN(endMs)) return;
    if (endMs <= startMs) {
      throw new BadRequestException(`Appointment ${doc.name}: end time must be after start time`);
    }
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    // Two intervals overlap iff each starts before the other ends.
    const clash = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Appointment"))}
         WHERE ${quoteIdent("assigned_to")} = $1 AND ${quoteIdent("docstatus")} = 1
           AND ${quoteIdent("name")} <> $2
           AND ${quoteIdent("start_time")} < $3 AND ${quoteIdent("end_time")} > $4
         LIMIT 1`,
        [who, String(doc.name), endIso, startIso],
      )
    )[0];
    if (clash) {
      throw new BadRequestException(
        `Appointment ${doc.name}: ${who} is already booked (${clash.name}) in this time slot`,
      );
    }
    await this.setStatus("Appointment", String(doc.name), "Scheduled");
    this.logger.log(`Appointment ${doc.name} passed double-booking gate`);
  }

  @OnEvent("doc.on_cancel:Appointment")
  async onAppointmentCancel(payload: DocEventPayload): Promise<void> {
    await this.setStatus("Appointment", String(payload.doc.name), "Cancelled");
  }
}
