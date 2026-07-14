import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Shift & attendance behaviours. Pure event-bus listener, no cross-module imports:
 *
 *  1. on_submit/on_cancel of a Shift Assignment sets its Active/Cancelled status.
 *  2. before_save on Attendance derives working_hours from check_in/check_out,
 *     downgrades a short day to Half Day against the shift's expected hours, and
 *     blocks a duplicate attendance for the same employee on the same date.
 */
@Injectable()
export class ShiftListener {
  private readonly logger = new Logger(ShiftListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Shift Assignment")
  async onAssignmentSubmit(payload: DocEventPayload): Promise<void> {
    await this.setStatus("Shift Assignment", String(payload.doc.name), "Active");
  }

  @OnEvent("doc.on_cancel:Shift Assignment")
  async onAssignmentCancel(payload: DocEventPayload): Promise<void> {
    await this.setStatus("Shift Assignment", String(payload.doc.name), "Cancelled");
  }

  private async setStatus(doctype: string, name: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${quoteIdent("status")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [status, name],
    );
  }

  private async shiftHours(shift: unknown): Promise<number> {
    if (!shift || !this.registry.has("Shift Type")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("hours")} AS h FROM ${quoteIdent(tableNameFor("Shift Type"))}
         WHERE ${quoteIdent("name")} = $1`,
        [String(shift)],
      )
    )[0];
    return Number(row?.h ?? 0);
  }

  // suppressErrors:false so the duplicate-attendance gate can abort the write.
  @OnEvent("doc.before_save:Attendance", { suppressErrors: false })
  async onAttendanceSave(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    // Field defaults are UI-applied, not engine-applied, so default the status
    // here (a backend-created attendance would otherwise fail the reqd check).
    if (d.status === undefined || d.status === null || d.status === "") d.status = "Present";
    const employee = String(d.employee ?? "");
    const date = d.attendance_date;

    // Derive working hours from the check-in/out window.
    const inMs = d.check_in ? new Date(String(d.check_in)).getTime() : NaN;
    const outMs = d.check_out ? new Date(String(d.check_out)).getTime() : NaN;
    if (!Number.isNaN(inMs) && !Number.isNaN(outMs) && outMs > inMs) {
      const hours = Math.round(((outMs - inMs) / 3_600_000) * 100) / 100;
      d.working_hours = hours;
      // A day shorter than half the shift's expected hours is a Half Day.
      const expected = await this.shiftHours(d.shift);
      if (expected > 0 && hours < expected / 2 && String(d.status ?? "Present") === "Present") {
        d.status = "Half Day";
      }
    }

    // One attendance per employee per date.
    if (!employee || !date || !this.registry.has("Attendance")) return;
    const params: unknown[] = [employee, date];
    let sql = `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Attendance"))}
               WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("attendance_date")} = $2`;
    if (!payload.isNew && d.name) {
      params.push(String(d.name));
      sql += ` AND ${quoteIdent("name")} <> $3`;
    }
    const clash = (await this.dataSource.query(`${sql} LIMIT 1`, params))[0];
    if (clash) {
      throw new BadRequestException(
        `Attendance: ${employee} already has attendance (${clash.name}) on ${date}`,
      );
    }
  }
}
