import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Contact book side-effects. When a Contact flagged primary is created or
 * updated for a Customer, its email/mobile are rolled onto the Customer as the
 * canonical contact details, and any other primary contact of that customer is
 * demoted (one primary per customer). Pure event-bus listener; direct SQL
 * write-backs avoid event re-entry.
 */
@Injectable()
export class ContactListener {
  private readonly logger = new Logger(ContactListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.after_insert:Contact")
  async onInsert(payload: DocEventPayload): Promise<void> {
    await this.syncPrimary(payload.doc);
  }

  @OnEvent("doc.after_update:Contact")
  async onUpdate(payload: DocEventPayload): Promise<void> {
    await this.syncPrimary(payload.doc);
  }

  private async syncPrimary(doc: Record<string, unknown>): Promise<void> {
    if (!Boolean(doc.is_primary)) return;
    const customer = String(doc.customer ?? "");
    if (!customer || !this.registry.has("Customer")) return;

    // Demote other primary contacts of this customer.
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Contact"))} SET ${quoteIdent("is_primary")} = 0
       WHERE ${quoteIdent("customer")} = $1 AND ${quoteIdent("name")} <> $2
         AND ${quoteIdent("is_primary")} = 1`,
      [customer, String(doc.name)],
    );

    // Roll the primary contact's details onto the customer record.
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Customer"))}
       SET ${quoteIdent("email_id")} = coalesce($1, ${quoteIdent("email_id")}),
           ${quoteIdent("mobile_no")} = coalesce($2, ${quoteIdent("mobile_no")})
       WHERE ${quoteIdent("name")} = $3`,
      [doc.email_id ?? null, doc.mobile_no ?? null, customer],
    );
    this.logger.log(`Customer ${customer} primary contact -> ${doc.first_name} (${doc.email_id ?? "no email"})`);
  }
}
