import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const NEXT_PRIORITY: Record<string, string> = {
  Low: "Medium",
  Medium: "High",
  High: "Urgent",
  Urgent: "Urgent",
};

/**
 * Support SLA escalation. The SupportListener marks an SLA Fulfilled or Failed
 * when an issue is resolved, but an issue left open past its resolution deadline
 * stays "Ongoing" and unseen. This run proactively catches those: any un-resolved
 * issue whose `resolution_by` has passed is marked Failed, escalated one priority
 * level, and stamped so it is only escalated once. Pure SQL over the Issue table;
 * no cross-module service imports.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async escalateOverdueIssues(asOf?: string): Promise<{ escalated: string[] }> {
    if (!this.registry.has("Issue")) return { escalated: [] };
    const now = asOf ? new Date(asOf) : new Date();
    const nowIso = now.toISOString();
    const table = quoteIdent(tableNameFor("Issue"));

    // Open (not Resolved/Closed), still Ongoing, past resolution deadline, not yet escalated.
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("priority")} AS priority
       FROM ${table}
       WHERE ${quoteIdent("agreement_status")} = 'Ongoing'
         AND coalesce(${quoteIdent("status")}, 'Open') NOT IN ('Resolved', 'Closed')
         AND coalesce(${quoteIdent("escalated")}, 0) = 0
         AND ${quoteIdent("resolution_by")} IS NOT NULL
         AND ${quoteIdent("resolution_by")} < $1`,
      [nowIso],
    );

    const escalated: string[] = [];
    for (const row of rows as Array<{ name: string; priority: string }>) {
      const next = NEXT_PRIORITY[String(row.priority)] ?? String(row.priority);
      await this.dataSource.query(
        `UPDATE ${table}
         SET ${quoteIdent("agreement_status")} = 'Failed',
             ${quoteIdent("priority")} = $1,
             ${quoteIdent("escalated")} = 1,
             ${quoteIdent("escalation_date")} = $2
         WHERE ${quoteIdent("name")} = $3`,
        [next, nowIso, String(row.name)],
      );
      escalated.push(String(row.name));
    }
    this.logger.log(`SLA escalation: ${escalated.length} overdue issue(s) escalated as of ${nowIso}`);
    return { escalated };
  }
}
