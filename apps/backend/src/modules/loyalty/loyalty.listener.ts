import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Loyalty accrual. Submitting a Sales Invoice earns the customer points under
 * the default active Loyalty Program (floor(grand_total × collection_factor)),
 * recorded as an Accrual Loyalty Point Entry; cancelling the invoice removes its
 * accrual. A customer's balance is the sum of their point entries (accruals
 * positive, redemptions negative). Pure event-bus listener — no cross-module
 * service imports.
 */
@Injectable()
export class LoyaltyListener {
  private readonly logger = new Logger(LoyaltyListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async defaultProgram(): Promise<Record<string, unknown> | null> {
    const dt = this.registry.get("Loyalty Program");
    if (!dt) return null;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS n FROM ${quoteIdent(tableNameFor("Loyalty Program"))}
         WHERE ${quoteIdent("is_active")} = 1
         ORDER BY ${quoteIdent("is_default")} DESC, ${quoteIdent("creation")} ASC LIMIT 1`,
      )
    )[0];
    if (!row?.n) return null;
    return this.documents.get(dt, String(row.n));
  }

  @OnEvent("doc.on_submit:Sales Invoice")
  async onInvoiceSubmit(payload: DocEventPayload): Promise<void> {
    const inv = payload.doc;
    const lpeDt = this.registry.get("Loyalty Point Entry");
    if (!lpeDt || !inv.customer) return;
    try {
      const program = await this.defaultProgram();
      if (!program) return;
      const factor = Number(program.collection_factor ?? 0);
      const points = Math.floor(Number(inv.grand_total ?? 0) * factor);
      if (points <= 0) return;

      const ctx = systemContext(payload.user);
      await this.documents.create(lpeDt, ctx, {
        customer: inv.customer,
        loyalty_program: program.name,
        entry_type: "Accrual",
        posting_date: inv.posting_date ?? null,
        points,
        sales_invoice: inv.name,
      });
      this.logger.log(`Loyalty: ${inv.customer} earned ${points} pts on ${inv.name}`);
    } catch (err) {
      this.logger.error(`Loyalty accrual for ${inv.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Sales Invoice")
  async onInvoiceCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Loyalty Point Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("Loyalty Point Entry"))}
       WHERE ${quoteIdent("sales_invoice")} = $1 AND ${quoteIdent("entry_type")} = 'Accrual'`,
      [payload.doc.name],
    );
  }
}
