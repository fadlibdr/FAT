import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Employee Separation. Tracks an exit-activity checklist (completion % kept
 * current on save); a separation can only be completed once every activity is
 * Completed, and completing it marks the employee Left (cancel restores Active).
 * Pure event-bus listener — reads/writes via SQL, no cross-module service imports.
 */
@Injectable()
export class SeparationListener {
  private readonly logger = new Logger(SeparationListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private counts(rows: Array<Record<string, unknown>>): { total: number; done: number } {
    const total = rows.length;
    const done = rows.filter((r) => String(r.status ?? "Pending") === "Completed").length;
    return { total, done };
  }

  @OnEvent("doc.before_save:Employee Separation")
  onSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    const rows = (d.activities as Array<Record<string, unknown>>) ?? [];
    const { total, done } = this.counts(rows);
    d.total_activities = total;
    d.completed_activities = done;
    d.percent_complete = total > 0 ? Math.round((done / total) * 10000) / 100 : 0;
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Employee Separation", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const doc = payload.doc;
    const rows = (doc.activities as Array<Record<string, unknown>>) ?? [];
    if (rows.length === 0) {
      throw new BadRequestException(`Employee Separation ${doc.name}: add at least one exit activity`);
    }
    const { total, done } = this.counts(rows);
    if (done < total) {
      throw new BadRequestException(
        `Employee Separation ${doc.name}: ${total - done} of ${total} activities still pending — cannot complete separation`,
      );
    }
  }

  @OnEvent("doc.on_submit:Employee Separation")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Employee Separation"))} SET ${quoteIdent("status")} = 'Completed'
       WHERE ${quoteIdent("name")} = $1`,
      [String(doc.name)],
    );
    if (doc.employee && this.registry.has("Employee")) {
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Employee"))} SET ${quoteIdent("status")} = 'Left'
         WHERE ${quoteIdent("name")} = $1`,
        [String(doc.employee)],
      );
      this.logger.log(`Employee Separation ${doc.name}: ${doc.employee} marked Left`);
    }
  }

  @OnEvent("doc.on_cancel:Employee Separation")
  async onCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Employee Separation"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(doc.name)],
    );
    // Reinstate the employee only if they are still Left from this separation.
    if (doc.employee && this.registry.has("Employee")) {
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Employee"))} SET ${quoteIdent("status")} = 'Active'
         WHERE ${quoteIdent("name")} = $1 AND ${quoteIdent("status")} = 'Left'`,
        [String(doc.employee)],
      );
    }
  }
}
