import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const MONTHS: Record<string, number> = {
  Monthly: 1,
  Quarterly: 3,
  "Half-Yearly": 6,
  Yearly: 12,
};

/**
 * After-sales maintenance & warranty, all on the event bus (no cross-module
 * service imports):
 *
 *  1. before_save on a Warranty Claim derives its warranty status from the
 *     serial number's warranty expiry vs the complaint date (and fills item_code).
 *  2. before_save on a Maintenance Schedule expands start_date + periodicity +
 *     no_of_visits into dated visit rows.
 *  3. on_submit of a Maintenance Visit closes the earliest pending scheduled
 *     visit on its Maintenance Schedule.
 */
@Injectable()
export class MaintenanceListener {
  private readonly logger = new Logger(MaintenanceListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Warranty Claim")
  async onClaimSave(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    if (!d.serial_no || !this.registry.has("Serial No")) return;
    const serial = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("item")} AS item, ${quoteIdent("warranty_expiry_date")} AS expiry
         FROM ${quoteIdent(tableNameFor("Serial No"))} WHERE ${quoteIdent("name")} = $1`,
        [String(d.serial_no)],
      )
    )[0];
    if (!serial) return;
    if (!d.item_code && serial.item) d.item_code = serial.item;
    const complaint = d.complaint_date ? new Date(d.complaint_date as string) : null;
    const expiry = serial.expiry ? new Date(serial.expiry as string) : null;
    if (complaint && expiry) {
      d.warranty_status = complaint.getTime() <= expiry.getTime() ? "In Warranty" : "Out of Warranty";
    } else if (complaint) {
      d.warranty_status = "Out of Warranty";
    }
  }

  @OnEvent("doc.before_save:Maintenance Schedule")
  onScheduleSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    const existing = d.schedule as unknown[] | undefined;
    if (Array.isArray(existing) && existing.length > 0) return;
    if (!d.start_date || !d.periodicity || !d.no_of_visits) return;
    const start = new Date(d.start_date as string);
    if (Number.isNaN(start.getTime())) return;
    const n = Math.max(1, Number(d.no_of_visits) || 1);
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i += 1) {
      rows.push({ scheduled_date: this.advance(start, String(d.periodicity), i), status: "Pending" });
    }
    d.schedule = rows;
    this.logger.log(`Maintenance Schedule: generated ${rows.length} ${d.periodicity} visit(s)`);
  }

  @OnEvent("doc.on_submit:Maintenance Schedule")
  async onScheduleSubmit(p: DocEventPayload): Promise<void> {
    await this.setStatus("Maintenance Schedule", String(p.doc.name), "Submitted");
  }

  @OnEvent("doc.on_cancel:Maintenance Schedule")
  async onScheduleCancel(p: DocEventPayload): Promise<void> {
    await this.setStatus("Maintenance Schedule", String(p.doc.name), "Cancelled");
  }

  @OnEvent("doc.on_submit:Maintenance Visit")
  async onVisitSubmit(payload: DocEventPayload): Promise<void> {
    const visit = payload.doc;
    await this.setStatus("Maintenance Visit", String(visit.name), "Submitted");
    // A visit against a warranty claim resolves it.
    if (visit.warranty_claim && this.registry.has("Warranty Claim")) {
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Warranty Claim"))}
         SET ${quoteIdent("status")} = 'Resolved', ${quoteIdent("resolution_date")} = $1,
             ${quoteIdent("resolution")} = coalesce(${quoteIdent("resolution")}, $2)
         WHERE ${quoteIdent("name")} = $3 AND coalesce(${quoteIdent("status")}, 'Open') = 'Open'`,
        [visit.visit_date ?? null, visit.work_done ?? null, String(visit.warranty_claim)],
      );
      this.logger.log(`Maintenance Visit ${visit.name} resolved Warranty Claim ${visit.warranty_claim}`);
    }
    if (!visit.maintenance_schedule || !this.registry.has("Maintenance Schedule Detail")) return;
    // Close the earliest still-pending scheduled visit on the referenced schedule.
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Maintenance Schedule Detail"))}
         WHERE ${quoteIdent("parent")} = $1 AND ${quoteIdent("status")} = 'Pending'
         ORDER BY ${quoteIdent("scheduled_date")}, ${quoteIdent("idx")} LIMIT 1`,
        [String(visit.maintenance_schedule)],
      )
    )[0];
    if (!row) {
      this.logger.log(`Maintenance Visit ${visit.name}: no pending visit on ${visit.maintenance_schedule}`);
      return;
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Maintenance Schedule Detail"))}
       SET ${quoteIdent("status")} = 'Completed', ${quoteIdent("maintenance_visit")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [String(visit.name), String(row.name)],
    );
    this.logger.log(`Maintenance Visit ${visit.name} closed a visit on ${visit.maintenance_schedule}`);
  }

  @OnEvent("doc.on_cancel:Maintenance Visit")
  async onVisitCancel(p: DocEventPayload): Promise<void> {
    await this.setStatus("Maintenance Visit", String(p.doc.name), "Cancelled");
    // Reopen a warranty claim this visit had resolved.
    if (p.doc.warranty_claim && this.registry.has("Warranty Claim")) {
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Warranty Claim"))}
         SET ${quoteIdent("status")} = 'Open', ${quoteIdent("resolution_date")} = NULL
         WHERE ${quoteIdent("name")} = $1 AND ${quoteIdent("status")} = 'Resolved'`,
        [String(p.doc.warranty_claim)],
      );
    }
    if (!p.doc.maintenance_schedule || !this.registry.has("Maintenance Schedule Detail")) return;
    // Reopen the visit this document closed.
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Maintenance Schedule Detail"))}
       SET ${quoteIdent("status")} = 'Pending', ${quoteIdent("maintenance_visit")} = NULL
       WHERE ${quoteIdent("maintenance_visit")} = $1`,
      [String(p.doc.name)],
    );
  }

  private advance(start: Date, periodicity: string, i: number): string {
    const d = new Date(start.getTime());
    if (periodicity === "Weekly") d.setDate(d.getDate() + 7 * i);
    else d.setMonth(d.getMonth() + (MONTHS[periodicity] ?? 3) * i);
    return d.toISOString().slice(0, 10);
  }

  private async setStatus(doctype: string, name: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${quoteIdent("status")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [status, name],
    );
  }
}
