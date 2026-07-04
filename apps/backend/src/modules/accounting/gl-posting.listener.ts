import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const DEBTORS_ACCOUNT = "Debtors";
const SALES_ACCOUNT = "Sales";

/**
 * Posts double-entry GL Entries when a Sales Invoice is submitted, and removes
 * them when it is cancelled. Accounting never imports Selling — it only listens
 * on the document event bus, keeping the dependency one-directional.
 */
@Injectable()
export class GlPostingListener {
  private readonly logger = new Logger(GlPostingListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Sales Invoice")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    const doc = payload.doc;
    const amount = Number(doc.grand_total ?? doc.total ?? 0);
    if (!amount) return;
    const ctx = systemContext(payload.user);
    const common = {
      posting_date: doc.posting_date ?? null,
      voucher_type: "Sales Invoice",
      voucher_no: doc.name,
      company: doc.company ?? null,
    };
    try {
      // Debit the receivable, credit income.
      await this.documents.create(dt, ctx, {
        ...common,
        account: DEBTORS_ACCOUNT,
        debit: amount,
        credit: 0,
        against: String(doc.customer ?? ""),
      });
      await this.documents.create(dt, ctx, {
        ...common,
        account: SALES_ACCOUNT,
        debit: 0,
        credit: amount,
        against: String(doc.customer ?? ""),
      });
      this.logger.log(`Posted GL entries for Sales Invoice ${doc.name} (${amount})`);
    } catch (err) {
      this.logger.error(
        `Failed to post GL for ${doc.name}: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent("doc.on_cancel:Sales Invoice")
  async onCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      ["Sales Invoice", payload.doc.name],
    );
    this.logger.log(`Reversed GL entries for cancelled Sales Invoice ${payload.doc.name}`);
  }
}
