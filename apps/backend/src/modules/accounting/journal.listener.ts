import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Journal Entry posting. A manual voucher of account debit/credit rows:
 *
 *  1. before_save totals the rows into total_debit / total_credit.
 *  2. before_submit (suppressErrors:false) blocks an unbalanced entry —
 *     total debit must equal total credit and be non-zero.
 *  3. on_submit posts each row to the GL as a Journal Entry voucher; cancel
 *     deletes those GL entries. Pure event-bus listener, no cross-module imports.
 */
@Injectable()
export class JournalListener {
  private readonly logger = new Logger(JournalListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private totals(rows: Array<Record<string, unknown>>): { debit: number; credit: number } {
    let debit = 0;
    let credit = 0;
    for (const r of rows) {
      debit += Number(r.debit ?? 0);
      credit += Number(r.credit ?? 0);
    }
    return { debit: Math.round(debit * 100) / 100, credit: Math.round(credit * 100) / 100 };
  }

  @OnEvent("doc.before_save:Journal Entry")
  onSave(payload: BeforeSavePayload): void {
    const rows = (payload.data.accounts as Array<Record<string, unknown>>) ?? [];
    const { debit, credit } = this.totals(rows);
    payload.data.total_debit = debit;
    payload.data.total_credit = credit;
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Journal Entry", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const rows = (payload.doc.accounts as Array<Record<string, unknown>>) ?? [];
    const { debit, credit } = this.totals(rows);
    if (debit <= 0) {
      throw new BadRequestException(`Journal Entry ${payload.doc.name}: total debit must be greater than zero`);
    }
    if (Math.abs(debit - credit) > 0.0001) {
      throw new BadRequestException(
        `Journal Entry ${payload.doc.name}: not balanced — debit ${debit} vs credit ${credit}`,
      );
    }
  }

  @OnEvent("doc.on_submit:Journal Entry")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const against = String(doc.user_remark ?? "Journal Entry");
    try {
      for (const r of (doc.accounts as Array<Record<string, unknown>>) ?? []) {
        const debit = Number(r.debit ?? 0);
        const credit = Number(r.credit ?? 0);
        if (!debit && !credit) continue;
        await this.documents.create(dt, ctx, {
          posting_date: doc.posting_date ?? null,
          voucher_type: "Journal Entry",
          voucher_no: String(doc.name),
          account: r.account,
          debit,
          credit,
          against,
        });
      }
      this.logger.log(`Posted GL for Journal Entry ${doc.name} (${doc.total_debit})`);
    } catch (err) {
      this.logger.error(`Journal Entry ${doc.name} GL failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Journal Entry")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = 'Journal Entry' AND ${quoteIdent("voucher_no")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
