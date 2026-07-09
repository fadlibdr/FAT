import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Service-level tracking for support Issues. On creation, the applicable SLA
 * (the one already linked, else the default active one) sets the first-response
 * and resolution deadlines from its per-priority targets. When an Issue is moved
 * to Resolved/Closed, its resolution time is compared to the deadline and the
 * agreement is marked Fulfilled or Failed. Direct SQL write-backs avoid event
 * re-entry. Pure event-bus listener — no cross-module service imports.
 */
@Injectable()
export class SupportListener {
  private readonly logger = new Logger(SupportListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async setIssue(name: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Issue"))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  /** The Issue's own SLA if set, else the default active Service Level Agreement. */
  private async resolveSla(doc: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const slaDt = this.registry.get("Service Level Agreement");
    if (!slaDt) return null;
    if (doc.service_level_agreement) {
      try {
        return await this.documents.get(slaDt, String(doc.service_level_agreement));
      } catch {
        /* fall through to default */
      }
    }
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS n FROM ${quoteIdent(tableNameFor("Service Level Agreement"))}
         WHERE ${quoteIdent("is_active")} = 1
         ORDER BY ${quoteIdent("is_default")} DESC, ${quoteIdent("creation")} ASC LIMIT 1`,
      )
    )[0];
    if (!row?.n) return null;
    return this.documents.get(slaDt, String(row.n));
  }

  @OnEvent("doc.after_insert:Issue")
  async onIssueInsert(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    try {
      const sla = await this.resolveSla(doc);
      if (!sla) return;
      const priorities = (sla.priorities as Array<Record<string, unknown>>) ?? [];
      const target =
        priorities.find((p) => String(p.priority) === String(doc.priority ?? "Medium")) ??
        priorities[0];
      if (!target) return;

      const opening = doc.opening_date ? new Date(String(doc.opening_date)) : new Date();
      const responseBy = new Date(opening.getTime() + Number(target.response_time_hours ?? 0) * 3600_000);
      const resolutionBy = new Date(opening.getTime() + Number(target.resolution_time_hours ?? 0) * 3600_000);

      await this.setIssue(String(doc.name), {
        service_level_agreement: sla.name,
        opening_date: opening.toISOString(),
        response_by: responseBy.toISOString(),
        resolution_by: resolutionBy.toISOString(),
        agreement_status: "Ongoing",
      });
      this.logger.log(
        `Issue ${doc.name}: SLA ${sla.name} (${doc.priority}) response_by ${responseBy.toISOString()}`,
      );
    } catch (err) {
      this.logger.error(`Issue ${doc.name} SLA stamp failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.after_update:Issue")
  async onIssueUpdate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const resolved = ["Resolved", "Closed"].includes(String(doc.status));
    // Only close out the SLA once, while it is still running.
    if (!resolved || String(doc.agreement_status) !== "Ongoing") return;
    const now = new Date();
    const deadline = doc.resolution_by ? new Date(String(doc.resolution_by)) : null;
    const status = deadline && now.getTime() > deadline.getTime() ? "Failed" : "Fulfilled";
    await this.setIssue(String(doc.name), {
      resolution_date: now.toISOString(),
      agreement_status: status,
    });
    this.logger.log(`Issue ${doc.name} resolved -> ${status}`);
  }
}
