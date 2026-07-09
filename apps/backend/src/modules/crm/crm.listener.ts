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
 * CRM pipeline conversions. Marking a Lead "Converted" creates a Customer (once)
 * and links it back; marking an Opportunity "Converted" spins up a draft
 * Quotation from its items (once) and links it back. Idempotent via the stamped
 * back-links; direct SQL write-backs avoid event re-entry. Pure event-bus
 * listener — CRM imports no other module's services.
 */
@Injectable()
export class CrmListener {
  private readonly logger = new Logger(CrmListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async stamp(doctype: string, name: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  @OnEvent("doc.after_update:Lead")
  async onLeadUpdate(payload: DocEventPayload): Promise<void> {
    const lead = payload.doc;
    if (String(lead.status) !== "Converted" || lead.customer) return;
    const custDt = this.registry.get("Customer");
    if (!custDt) return;
    const ctx = systemContext(payload.user);
    const customerName = String(lead.lead_name);
    try {
      // Customer is named by customer_name; reuse an existing one if present.
      let name = customerName;
      try {
        const created = await this.documents.create(custDt, ctx, {
          customer_name: customerName,
          territory: lead.territory ?? null,
          email_id: lead.email_id ?? null,
          mobile_no: lead.mobile_no ?? null,
        });
        name = String(created.name);
      } catch (err) {
        if ((err as { status?: number }).status !== 409) throw err;
      }
      await this.stamp("Lead", String(lead.name), { customer: name });
      this.logger.log(`Lead ${lead.name} converted -> Customer ${name}`);
    } catch (err) {
      this.logger.error(`Lead ${lead.name} conversion failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.after_update:Opportunity")
  async onOpportunityUpdate(payload: DocEventPayload): Promise<void> {
    const opp = payload.doc;
    if (String(opp.status) !== "Converted" || opp.quotation) return;
    const qtnDt = this.registry.get("Quotation");
    if (!qtnDt) return;
    const items = (opp.items as Array<Record<string, unknown>>) ?? [];
    if (items.length === 0) return;
    const ctx = systemContext(payload.user);
    try {
      const quotation = await this.documents.create(qtnDt, ctx, {
        customer: opp.customer,
        transaction_date: new Date().toISOString().slice(0, 10),
        items: items.map((i) => ({ item_code: i.item_code, qty: i.qty, rate: i.rate })),
      });
      await this.stamp("Opportunity", String(opp.name), { quotation: quotation.name });
      this.logger.log(`Opportunity ${opp.name} converted -> Quotation ${quotation.name}`);
    } catch (err) {
      this.logger.error(`Opportunity ${opp.name} conversion failed: ${(err as Error).message}`);
    }
  }
}
