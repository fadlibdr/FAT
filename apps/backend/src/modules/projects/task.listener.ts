import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Epoch milliseconds for a date value (Date fields deserialize as Date objects). */
function ms(value: unknown): number {
  return new Date(String(value)).getTime();
}

/**
 * Task scheduling and project progress. Pure event-bus listener — Projects
 * imports no other module's services.
 *
 *  1. before_save gate (suppressErrors:false): a task's end may not precede its
 *     start, and a dependent task may not start before the task it depends on
 *     finishes (finish-to-start).
 *  2. after_insert / after_update recompute the parent Project's
 *     percent_complete as the average progress of its tasks.
 */
@Injectable()
export class TaskListener {
  private readonly logger = new Logger(TaskListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so a thrown scheduling error aborts the write.
  @OnEvent("doc.before_save:Task", { suppressErrors: false })
  async onTaskSave(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    const start = d.exp_start_date;
    const end = d.exp_end_date;

    // A task cannot finish before it starts.
    if (start && end && ms(end) < ms(start)) {
      throw new BadRequestException("Expected End Date cannot be before Expected Start Date");
    }

    // Finish-to-start: this task may not start before its dependency finishes.
    const dependsOn = String(d.depends_on ?? "");
    if (start && dependsOn && this.registry.has("Task")) {
      const dep = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("exp_end_date")} AS exp_end_date
           FROM ${quoteIdent(tableNameFor("Task"))} WHERE ${quoteIdent("name")} = $1 LIMIT 1`,
          [dependsOn],
        )
      )[0];
      if (dep?.exp_end_date && ms(start) < ms(dep.exp_end_date)) {
        throw new BadRequestException(
          `Task cannot start before its dependency ${dependsOn} finishes (${String(dep.exp_end_date).slice(0, 10)})`,
        );
      }
    }
  }

  @OnEvent("doc.after_insert:Task")
  async onInsert(payload: DocEventPayload): Promise<void> {
    await this.recompute(String(payload.doc.project ?? ""));
  }

  @OnEvent("doc.after_update:Task")
  async onUpdate(payload: DocEventPayload): Promise<void> {
    await this.recompute(String(payload.doc.project ?? ""));
  }

  /** Recompute a project's percent_complete as the average progress of its tasks. */
  private async recompute(project: string): Promise<void> {
    if (!project || !this.registry.has("Project") || !this.registry.has("Task")) return;
    const row = (
      await this.dataSource.query(
        `SELECT avg(coalesce(${quoteIdent("progress")}, 0))::float8 AS pct
         FROM ${quoteIdent(tableNameFor("Task"))} WHERE ${quoteIdent("project")} = $1`,
        [project],
      )
    )[0];
    const pct = Math.round(Number(row?.pct ?? 0) * 100) / 100;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Project"))} SET ${quoteIdent("percent_complete")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [pct, project],
    );
    this.logger.log(`Project ${project}: percent_complete -> ${pct}`);
  }
}
