import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import { HrService } from "./hr.service";

/**
 * Leave behaviour, all on the event bus (no cross-module service imports):
 *
 *  1. before_save on a Leave Application derives its inclusive day count from the
 *     from/to dates.
 *  2. before_submit on a Leave Application (which the approval workflow routes
 *     through) blocks approval when the employee lacks enough balance for the
 *     requested paid days, or when the dates overlap an already-approved leave.
 *  3. on_submit marks each day of an approved leave as On Leave in Attendance;
 *     on_cancel removes those attendance rows.
 */
@Injectable()
export class HrListener {
  private readonly logger = new Logger(HrListener.name);

  constructor(
    private readonly hr: HrService,
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Leave Application")
  onLeaveSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    d.total_leave_days = HrService.leaveDays(d.from_date, d.to_date);
  }

  // suppressErrors:false so an insufficient-balance error aborts the submit
  // instead of being swallowed by the event emitter.
  @OnEvent("doc.before_submit:Leave Application", { suppressErrors: false })
  async gateLeave(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const employee = String(doc.employee ?? "");
    const leaveType = String(doc.leave_type ?? "");
    if (!employee || !leaveType) return;
    await this.gateOverlap(employee, String(doc.name ?? ""), doc.from_date, doc.to_date);
    const requested = Number(doc.total_leave_days ?? 0) || HrService.leaveDays(doc.from_date, doc.to_date);
    const balance = await this.hr.balanceFor(employee, leaveType);
    if (requested > balance) {
      throw new BadRequestException(
        `Insufficient ${leaveType} balance for ${employee}: requested ${requested}, available ${balance}`,
      );
    }
    this.logger.log(`Leave ${doc.name} approved: ${requested} ${leaveType} day(s), balance was ${balance}`);
  }

  /** Reject a leave whose date range overlaps another submitted leave for the employee. */
  private async gateOverlap(employee: string, name: string, from: unknown, to: unknown): Promise<void> {
    if (!this.registry.has("Leave Application") || !from || !to) return;
    const clash = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS n FROM ${quoteIdent(tableNameFor("Leave Application"))}
         WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("docstatus")} = 1
           AND ${quoteIdent("name")} <> $2
           AND ${quoteIdent("from_date")} <= $4 AND ${quoteIdent("to_date")} >= $3
         LIMIT 1`,
        [employee, name, from, to],
      )
    )[0];
    if (clash) {
      throw new BadRequestException(
        `Leave for ${employee} overlaps existing approved leave ${clash.n}`,
      );
    }
  }

  @OnEvent("doc.on_submit:Leave Application")
  async onLeaveSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const attDt = this.registry.get("Attendance");
    if (!attDt) return;
    const employee = String(doc.employee ?? "");
    const ctx = systemContext(payload.user);
    const days = this.eachDay(doc.from_date, doc.to_date);
    let created = 0;
    for (const date of days) {
      if (await this.attendanceExists(employee, date)) continue;
      try {
        await this.documents.create(attDt, ctx, {
          employee,
          attendance_date: date,
          status: "On Leave",
          leave_application: doc.name,
        });
        created++;
      } catch (err) {
        this.logger.error(`Attendance for ${employee} ${date}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Leave ${doc.name}: marked ${created} day(s) On Leave in Attendance`);
  }

  @OnEvent("doc.on_cancel:Leave Application")
  async onLeaveCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Attendance")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("Attendance"))} WHERE ${quoteIdent("leave_application")} = $1`,
      [String(payload.doc.name)],
    );
  }

  /** Inclusive list of YYYY-MM-DD strings between two dates. */
  private eachDay(from: unknown, to: unknown): string[] {
    if (!from || !to) return [];
    const f = new Date(from as string);
    const t = new Date(to as string);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return [];
    const out: string[] = [];
    for (let d = f.getTime(); d <= t.getTime(); d += 86_400_000) {
      out.push(new Date(d).toISOString().slice(0, 10));
    }
    return out;
  }

  private async attendanceExists(employee: string, date: string): Promise<boolean> {
    const row = (
      await this.dataSource.query(
        `SELECT 1 FROM ${quoteIdent(tableNameFor("Attendance"))}
         WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("attendance_date")} = $2 LIMIT 1`,
        [employee, date],
      )
    )[0];
    return Boolean(row);
  }
}
