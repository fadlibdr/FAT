import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Default win-probability (%) for each sales stage. */
const STAGE_PROBABILITY: Record<string, number> = {
  Prospecting: 10,
  Qualification: 25,
  Proposal: 50,
  Negotiation: 75,
  "Closed Won": 100,
  "Closed Lost": 0,
};

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

  /**
   * Sales-pipeline forecasting. Derives a win probability from the sales stage
   * (unless one is entered) and computes the weighted (forecast) value as
   * amount × probability. Terminal stages are hard overrides: a Closed Won deal
   * is 100% (full weighted value), a Closed Lost deal is 0% (drops out of the
   * forecast) regardless of any entered probability.
   */
  /**
   * Derive the win probability from the sales stage. Terminal stages are hard
   * overrides (Closed Won = 100%, Closed Lost = 0%); for an open stage the stage
   * default applies only when the save does not carry an explicit probability, so
   * a manually entered probability sticks. Runs on before_save because it acts on
   * the fields being changed; the weighted value is then computed post-write (it
   * needs the persisted amount, which a partial update may omit).
   */
  @OnEvent("doc.before_save:Opportunity")
  onOpportunitySave(payload: BeforeSavePayload): void {
    const d = payload.data;
    const stage = String(d.sales_stage ?? "Prospecting");
    if (stage === "Closed Won" || stage === "Closed Lost") {
      d.probability = STAGE_PROBABILITY[stage];
    } else if (d.probability === undefined || d.probability === null || d.probability === "") {
      d.probability = STAGE_PROBABILITY[stage] ?? 0;
    } else {
      d.probability = Number(d.probability);
    }
  }

  @OnEvent("doc.after_insert:Opportunity")
  async onOpportunityInsert(payload: DocEventPayload): Promise<void> {
    await this.recomputeWeighted(String(payload.doc.name));
  }

  @OnEvent("doc.after_update:Opportunity")
  async onOpportunityWeighted(payload: DocEventPayload): Promise<void> {
    await this.recomputeWeighted(String(payload.doc.name));
  }

  /** weighted_amount = amount × probability, computed from the persisted row. */
  private async recomputeWeighted(name: string): Promise<void> {
    if (!name || !this.registry.has("Opportunity")) return;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(${quoteIdent("opportunity_amount")}, 0) AS amount,
                coalesce(${quoteIdent("probability")}, 0) AS probability,
                coalesce(${quoteIdent("weighted_amount")}, 0) AS weighted
         FROM ${quoteIdent(tableNameFor("Opportunity"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (!row) return;
    const weighted = Math.round(Number(row.amount) * (Number(row.probability) / 100) * 100) / 100;
    // Raw-SQL write-back (no event re-entry); skip if already correct.
    if (Math.abs(weighted - Number(row.weighted)) < 0.005) return;
    await this.stamp("Opportunity", name, { weighted_amount: weighted });
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
