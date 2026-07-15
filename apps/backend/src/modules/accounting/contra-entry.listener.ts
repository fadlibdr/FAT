import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Internal transfer. A Contra Entry moves money between two of the company's own
 * accounts (e.g. a cash deposit into the bank): Dr the receiving account / Cr the
 * paying account. Pure event-bus listener — no cross-module service imports.
 */
@Injectable()
export class ContraEntryListener {
  private readonly logger = new Logger(ContraEntryListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so an invalid transfer aborts the submit.
  @OnEvent("doc.before_submit:Contra Entry", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const doc = payload.doc;
    const amount = Number(doc.amount ?? 0);
    if (amount <= 0) throw new BadRequestException(`Contra Entry ${doc.name}: amount must be greater than zero`);
    if (String(doc.from_account ?? "") === String(doc.to_account ?? "")) {
      throw new BadRequestException(`Contra Entry ${doc.name}: from and to accounts must differ`);
    }
  }

  @OnEvent("doc.on_submit:Contra Entry")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const ctx = systemContext(payload.user);
    const amount = Number(doc.amount ?? 0);
    if (amount <= 0) return;
    const from = String(doc.from_account ?? "");
    const to = String(doc.to_account ?? "");
    const against = String(doc.remark ?? "Internal Transfer");
    try {
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Contra Entry",
        voucher_no: String(doc.name), account: to, debit: amount, credit: 0, against,
      });
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Contra Entry",
        voucher_no: String(doc.name), account: from, debit: 0, credit: amount, against,
      });
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Contra Entry"))} SET ${quoteIdent("status")} = 'Submitted'
         WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(`Contra Entry ${doc.name}: ${amount} (Dr ${to} / Cr ${from})`);
    } catch (err) {
      this.logger.error(`Contra Entry ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Contra Entry")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = 'Contra Entry' AND ${quoteIdent("voucher_no")} = $1`,
        [String(payload.doc.name)],
      );
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Contra Entry"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
