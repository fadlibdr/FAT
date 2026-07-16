import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Project & Task lifecycle. Completing a task requires its dependency to be
 * completed first (finish-to-start on status, complementing the date gate in
 * TaskListener); closing a project requires every task to be Completed or
 * Cancelled. Pure SQL over sibling tables; Projects imports no other module's
 * services.
 */
@Injectable()
export class ProjectService {
  private readonly logger = new Logger(ProjectService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Mark a Task Completed (progress 100). Refuses if the task it depends on is
   * not itself Completed — enforcing finish-to-start on status. The write fires
   * after_update, so TaskListener recomputes the project's percent_complete.
   */
  async completeTask(name: string): Promise<{ task: string; status: string }> {
    if (!this.registry.has("Task")) throw new BadRequestException("Task not registered");
    const task = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("status")} AS status, ${quoteIdent("depends_on")} AS depends_on,
                ${quoteIdent("project")} AS project
         FROM ${quoteIdent(tableNameFor("Task"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (!task) throw new BadRequestException(`Task ${name} not found`);
    if (String(task.status) === "Completed") throw new BadRequestException(`Task ${name} is already Completed`);

    const dependsOn = String(task.depends_on ?? "");
    if (dependsOn) {
      const dep = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("status")} AS status FROM ${quoteIdent(tableNameFor("Task"))}
           WHERE ${quoteIdent("name")} = $1`,
          [dependsOn],
        )
      )[0];
      if (dep && String(dep.status) !== "Completed") {
        throw new BadRequestException(
          `Task ${name} cannot be completed before its dependency ${dependsOn} is Completed (is ${dep.status})`,
        );
      }
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Task"))}
       SET ${quoteIdent("status")} = 'Completed', ${quoteIdent("progress")} = 100
       WHERE ${quoteIdent("name")} = $1`,
      [name],
    );
    await this.recomputeProject(String(task.project ?? "") || (await this.projectOf(name)));
    this.logger.log(`Task ${name} completed`);
    return { task: name, status: "Completed" };
  }

  /**
   * Close a Project: mark it Completed, but only once every task is Completed or
   * Cancelled. Reports the number of still-open tasks otherwise.
   */
  async closeProject(name: string): Promise<{ project: string; status: string }> {
    if (!this.registry.has("Project")) throw new BadRequestException("Project not registered");
    const proj = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("status")} AS status FROM ${quoteIdent(tableNameFor("Project"))}
         WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (!proj) throw new BadRequestException(`Project ${name} not found`);
    if (String(proj.status) === "Completed") throw new BadRequestException(`Project ${name} is already Completed`);

    if (this.registry.has("Task")) {
      const open = Number(
        (
          await this.dataSource.query(
            `SELECT count(*) AS c FROM ${quoteIdent(tableNameFor("Task"))}
             WHERE ${quoteIdent("project")} = $1 AND coalesce(${quoteIdent("status")}, 'Open') NOT IN ('Completed', 'Cancelled')`,
            [name],
          )
        )[0]?.c ?? 0,
      );
      if (open > 0) {
        throw new BadRequestException(`Project ${name} has ${open} open task(s) — complete or cancel them before closing`);
      }
    }
    await this.setProjectStatus(name, "Completed");
    this.logger.log(`Project ${name} closed`);
    return { project: name, status: "Completed" };
  }

  /** Reopen a completed project. */
  async reopenProject(name: string): Promise<{ project: string; status: string }> {
    if (!this.registry.has("Project")) throw new BadRequestException("Project not registered");
    await this.setProjectStatus(name, "Open");
    this.logger.log(`Project ${name} reopened`);
    return { project: name, status: "Open" };
  }

  private async projectOf(task: string): Promise<string> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("project")} AS project FROM ${quoteIdent(tableNameFor("Task"))}
         WHERE ${quoteIdent("name")} = $1`,
        [task],
      )
    )[0];
    return String(row?.project ?? "");
  }

  private async recomputeProject(project: string): Promise<void> {
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
  }

  private async setProjectStatus(name: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Project"))} SET ${quoteIdent("status")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [status, name],
    );
  }
}
