import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Employee Promotion. Submitting a promotion snapshots the employee's current
 * designation onto the document and applies the new designation to the employee
 * record; cancelling restores the snapshotted designation. A before_submit gate
 * keeps the promotion date sane and the employee active. Pure event-bus listener
 * — reads/writes via SQL, no cross-module service imports.
 */
@Injectable()
export class EmployeePromotionListener {
  private readonly logger = new Logger(EmployeePromotionListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** UTC YYYY-MM-DD for a date value. */
  private isoDay(value: unknown): string {
    const d = value instanceof Date ? value : new Date(String(value));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  private async employee(name: string): Promise<Record<string, unknown> | undefined> {
    if (!name || !this.registry.has("Employee")) return undefined;
    return (
      await this.dataSource.query(
        `SELECT ${quoteIdent("designation")} AS designation, ${quoteIdent("status")} AS status,
                ${quoteIdent("date_of_joining")} AS date_of_joining
         FROM ${quoteIdent(tableNameFor("Employee"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Employee Promotion", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const emp = await this.employee(String(doc.employee ?? ""));
    if (!emp) throw new BadRequestException(`Employee ${doc.employee} not found`);
    if (String(emp.status ?? "Active") !== "Active") {
      throw new BadRequestException(`Employee ${doc.employee} is not Active (is ${emp.status})`);
    }
    if (!String(doc.new_designation ?? "").trim()) {
      throw new BadRequestException("New Designation is required");
    }
    if (emp.date_of_joining && doc.promotion_date && this.isoDay(doc.promotion_date) < this.isoDay(emp.date_of_joining)) {
      throw new BadRequestException(
        `Promotion date ${this.isoDay(doc.promotion_date)} cannot be before the joining date ${this.isoDay(emp.date_of_joining)}`,
      );
    }
  }

  @OnEvent("doc.on_submit:Employee Promotion")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const emp = await this.employee(String(doc.employee ?? ""));
    if (!emp) return;
    const current = String(emp.designation ?? "");
    // Snapshot the pre-promotion designation for a clean reversal, then apply.
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Employee Promotion"))}
       SET ${quoteIdent("current_designation")} = $1, ${quoteIdent("status")} = 'Submitted'
       WHERE ${quoteIdent("name")} = $2`,
      [current, String(doc.name)],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Employee"))} SET ${quoteIdent("designation")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [String(doc.new_designation ?? ""), String(doc.employee ?? "")],
    );
    this.logger.log(`Employee Promotion ${doc.name}: ${doc.employee} ${current || "—"} -> ${doc.new_designation}`);
  }

  @OnEvent("doc.on_cancel:Employee Promotion")
  async onCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    // Restore the snapshotted designation only if the employee still carries the
    // promoted one (a later promotion would have moved them on).
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Employee"))} SET ${quoteIdent("designation")} = $1
       WHERE ${quoteIdent("name")} = $2 AND ${quoteIdent("designation")} = $3`,
      [String(doc.current_designation ?? ""), String(doc.employee ?? ""), String(doc.new_designation ?? "")],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Employee Promotion"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(doc.name)],
    );
    this.logger.log(`Employee Promotion ${doc.name} cancelled — designation reverted`);
  }
}
