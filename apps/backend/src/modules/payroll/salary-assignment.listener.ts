import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Salary Structure Assignment ties an employee to a salary structure effective
 * from a date. Two pure event-bus behaviours, no cross-module imports:
 *
 *  1. before_save on a Salary Slip with no structure resolves the employee's
 *     active assignment (latest from_date on/before the slip's period start) and
 *     stamps its structure, so slips follow the assigned structure automatically.
 *  2. before_submit on an assignment validates its date, the structure's active
 *     flag, and that the employee has no other submitted assignment on the same
 *     from_date.
 */
@Injectable()
export class SalaryAssignmentListener {
  private readonly logger = new Logger(SalaryAssignmentListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Salary Slip")
  async resolveStructure(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    if (d.salary_structure || !d.employee || !this.registry.has("Salary Structure Assignment")) return;
    const asOf = d.start_date
      ? new Date(d.start_date as string).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("salary_structure")} AS s FROM ${quoteIdent(tableNameFor("Salary Structure Assignment"))}
         WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("docstatus")} = 1
           AND ${quoteIdent("from_date")} <= $2
         ORDER BY ${quoteIdent("from_date")} DESC LIMIT 1`,
        [String(d.employee), asOf],
      )
    )[0];
    if (row?.s) {
      d.salary_structure = row.s;
      this.logger.log(`Salary Slip for ${d.employee}: resolved structure ${row.s} (as of ${asOf})`);
    }
  }

  // suppressErrors:false so a bad assignment aborts the submit.
  @OnEvent("doc.before_submit:Salary Structure Assignment", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const employee = String(doc.employee ?? "");
    const structure = String(doc.salary_structure ?? "");
    const fromDate = doc.from_date;
    if (!fromDate) throw new BadRequestException("From Date is required");

    if (structure && this.registry.has("Salary Structure")) {
      const s = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("is_active")} AS a FROM ${quoteIdent(tableNameFor("Salary Structure"))}
           WHERE ${quoteIdent("name")} = $1`,
          [structure],
        )
      )[0];
      if (s && Number(s.a ?? 0) !== 1) {
        throw new BadRequestException(`Salary Structure ${structure} is not active`);
      }
    }

    const dup = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS n FROM ${quoteIdent(tableNameFor("Salary Structure Assignment"))}
         WHERE ${quoteIdent("employee")} = $1 AND ${quoteIdent("docstatus")} = 1
           AND ${quoteIdent("name")} <> $2 AND ${quoteIdent("from_date")} = $3
         LIMIT 1`,
        [employee, String(doc.name ?? ""), fromDate],
      )
    )[0];
    if (dup) {
      const day = new Date(fromDate as string).toISOString().slice(0, 10);
      throw new BadRequestException(`${employee} already has assignment ${dup.n} effective ${day}`);
    }
  }
}
