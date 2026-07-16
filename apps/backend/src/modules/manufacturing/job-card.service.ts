import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Job Card execution. Job Cards are created per BOM operation when a Work Order
 * is submitted (see ManufacturingListener); this service drives each card
 * through its shop-floor lifecycle — Open → Work In Progress (start) → Completed
 * (complete, recording actual minutes) — and finishes a Work Order only once all
 * of its cards are complete. Pure SQL over sibling tables; no cross-module
 * service imports.
 */
@Injectable()
export class JobCardService {
  private readonly logger = new Logger(JobCardService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Start a Job Card: Open → Work In Progress. */
  async start(name: string): Promise<{ job_card: string; status: string }> {
    const row = await this.cardRow(name);
    if (String(row.status) !== "Open") {
      throw new BadRequestException(`Job Card ${name} must be Open to start (is ${row.status})`);
    }
    await this.setCard(name, { status: "Work In Progress" });
    this.logger.log(`Job Card ${name} started`);
    return { job_card: name, status: "Work In Progress" };
  }

  /**
   * Complete a Job Card, recording actual minutes (defaults to the planned time
   * when not supplied). A card must be Open or Work In Progress to complete.
   */
  async complete(name: string, actualMinutes?: number): Promise<{ job_card: string; status: string }> {
    const row = await this.cardRow(name);
    if (String(row.status) === "Completed") {
      throw new BadRequestException(`Job Card ${name} is already Completed`);
    }
    const actual = actualMinutes != null && actualMinutes >= 0 ? actualMinutes : Number(row.time_in_mins ?? 0);
    await this.setCard(name, { status: "Completed", actual_time_in_mins: actual });
    this.logger.log(`Job Card ${name} completed (${actual} min)`);
    return { job_card: name, status: "Completed" };
  }

  /**
   * Finish a Work Order: mark it Completed, but only once every one of its Job
   * Cards is Completed. Lists the outstanding count otherwise.
   */
  async finishWorkOrder(workOrder: string): Promise<{ work_order: string; status: string }> {
    if (!this.registry.has("Work Order")) throw new BadRequestException("Work Order not registered");
    const wo = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("docstatus")} AS docstatus, ${quoteIdent("status")} AS status
         FROM ${quoteIdent(tableNameFor("Work Order"))} WHERE ${quoteIdent("name")} = $1`,
        [workOrder],
      )
    )[0];
    if (!wo) throw new BadRequestException(`Work Order ${workOrder} not found`);
    if (Number(wo.docstatus ?? 0) !== 1) throw new BadRequestException(`Work Order ${workOrder} must be submitted`);
    if (String(wo.status) === "Completed") throw new BadRequestException(`Work Order ${workOrder} is already Completed`);

    if (this.registry.has("Job Card")) {
      const open = Number(
        (
          await this.dataSource.query(
            `SELECT count(*) AS c FROM ${quoteIdent(tableNameFor("Job Card"))}
             WHERE ${quoteIdent("work_order")} = $1 AND ${quoteIdent("status")} <> 'Completed'`,
            [workOrder],
          )
        )[0]?.c ?? 0,
      );
      if (open > 0) {
        throw new BadRequestException(
          `Work Order ${workOrder} has ${open} incomplete Job Card(s) — complete them before finishing`,
        );
      }
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Work Order"))} SET ${quoteIdent("status")} = 'Completed'
       WHERE ${quoteIdent("name")} = $1`,
      [workOrder],
    );
    this.logger.log(`Work Order ${workOrder} finished (Completed)`);
    return { work_order: workOrder, status: "Completed" };
  }

  private async cardRow(name: string): Promise<Record<string, unknown>> {
    if (!this.registry.has("Job Card")) throw new BadRequestException("Job Card not registered");
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("status")} AS status, ${quoteIdent("time_in_mins")} AS time_in_mins
         FROM ${quoteIdent(tableNameFor("Job Card"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (!row) throw new BadRequestException(`Job Card ${name} not found`);
    return row;
  }

  private async setCard(name: string, fields: Record<string, unknown>): Promise<void> {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${quoteIdent(k)} = $${i + 2}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Job Card"))} SET ${sets} WHERE ${quoteIdent("name")} = $1`,
      [name, ...keys.map((k) => fields[k])],
    );
  }
}
