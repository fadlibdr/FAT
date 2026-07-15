import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/** Advance an ISO date by the template's frequency, returning YYYY-MM-DD. */
function advance(date: string, frequency: string): string {
  const d = new Date(date);
  if (frequency === "Weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Recurring journal run. For each enabled Recurring Journal due on or before the
 * cutoff, posts a balanced Journal Entry from its account rows (the JournalListener
 * validates the balance and posts the GL) for every period up to the cutoff, then
 * advances the template's next posting date — so a repeat run posts nothing more.
 */
@Injectable()
export class RecurringJournalService {
  private readonly logger = new Logger(RecurringJournalService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async run(asOf?: string, ctx?: UserContext): Promise<{ templates: number; entries: number }> {
    const jeDt = this.registry.get("Journal Entry");
    if (!jeDt || !this.registry.has("Recurring Journal")) return { templates: 0, entries: 0 };
    const context = ctx ?? systemContext();
    const cutoff = asOf ?? new Date().toISOString().slice(0, 10);

    const templates: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("frequency")} AS frequency,
              ${quoteIdent("next_date")} AS next_date, ${quoteIdent("company")} AS company,
              ${quoteIdent("user_remark")} AS user_remark
       FROM ${quoteIdent(tableNameFor("Recurring Journal"))}
       WHERE coalesce(${quoteIdent("enabled")}, 0) = 1 AND ${quoteIdent("next_date")} <= $1`,
      [cutoff],
    );

    let entries = 0;
    let touched = 0;
    for (const t of templates) {
      const rows = await this.accounts(String(t.name));
      if (rows.length === 0) continue;
      let next = new Date(String(t.next_date)).toISOString().slice(0, 10);
      let posted = false;
      // Catch up: one entry per due period up to the cutoff.
      while (next <= cutoff) {
        try {
          const je = await this.documents.create(jeDt, context, {
            posting_date: next,
            company: t.company ?? null,
            user_remark: (t.user_remark as string) ?? `Recurring: ${t.name}`,
            recurring_journal: String(t.name),
            accounts: rows.map((r) => ({ account: r.account, debit: r.debit, credit: r.credit })),
          });
          await this.documents.setDocStatus(jeDt, context, String(je.name), 1);
          entries += 1;
          posted = true;
        } catch (err) {
          this.logger.error(`Recurring Journal ${t.name} (${next}) failed: ${(err as Error).message}`);
          break;
        }
        next = advance(next, String(t.frequency));
      }
      if (posted) {
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Recurring Journal"))} SET ${quoteIdent("next_date")} = $1
           WHERE ${quoteIdent("name")} = $2`,
          [next, String(t.name)],
        );
        touched += 1;
      }
    }
    this.logger.log(`Recurring journal run (<= ${cutoff}): ${touched} template(s), ${entries} entries`);
    return { templates: touched, entries };
  }

  private async accounts(template: string): Promise<Array<Record<string, unknown>>> {
    if (!this.registry.has("Recurring Journal Account")) return [];
    return this.dataSource.query(
      `SELECT ${quoteIdent("account")} AS account, coalesce(${quoteIdent("debit")}, 0) AS debit,
              coalesce(${quoteIdent("credit")}, 0) AS credit
       FROM ${quoteIdent(tableNameFor("Recurring Journal Account"))} WHERE ${quoteIdent("parent")} = $1`,
      [template],
    );
  }
}
