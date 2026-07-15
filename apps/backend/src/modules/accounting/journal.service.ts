import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Journal Entry reversal: draw a draft mirror of a posted entry with every row's
 * debit and credit swapped, so submitting it unwinds the original's GL exactly.
 * The reversal links back via reversal_of. Created through the generic
 * DocumentService; the JournalListener posts and balances it like any other entry.
 */
@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Build a draft reversing Journal Entry for a submitted entry. Refuses an
   * unsubmitted entry, one that is itself a reversal, or one already reversed by a
   * live (non-cancelled) entry.
   */
  async makeReversal(je: string, ctx?: UserContext): Promise<string> {
    const jeDt = this.registry.get("Journal Entry");
    if (!jeDt) throw new BadRequestException("Journal Entry not registered");
    const context = ctx ?? systemContext();
    const entry = await this.documents.get(jeDt, je);
    if ((entry.docstatus ?? 0) !== 1) throw new BadRequestException("Journal Entry must be submitted");
    if (entry.reversal_of) throw new BadRequestException(`Journal Entry ${je} is itself a reversal`);

    const existing = (
      await this.dataSource.query(
        `SELECT count(*)::int AS n FROM ${quoteIdent(tableNameFor("Journal Entry"))}
         WHERE ${quoteIdent("reversal_of")} = $1 AND coalesce(${quoteIdent("docstatus")}, 0) <> 2`,
        [je],
      )
    )[0];
    if (Number(existing?.n ?? 0) > 0) throw new BadRequestException(`Journal Entry ${je} is already reversed`);

    const accounts = ((entry.accounts as Array<Record<string, unknown>>) ?? []).map((r) => ({
      account: r.account,
      debit: Number(r.credit ?? 0),
      credit: Number(r.debit ?? 0),
    }));
    if (accounts.length === 0) throw new BadRequestException(`Journal Entry ${je} has no rows`);

    const reversal = await this.documents.create(jeDt, context, {
      posting_date: new Date().toISOString().slice(0, 10),
      company: entry.company ?? null,
      user_remark: `Reversal of ${je}`,
      reversal_of: je,
      accounts,
    });
    this.logger.log(`Journal Entry ${je} -> reversal ${reversal.name}`);
    return String(reversal.name);
  }
}
