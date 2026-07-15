import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * CRM conversions driven on demand (the CrmListener handles the automatic,
 * status-triggered ones). Creates documents through the generic DocumentService —
 * CRM imports no other module's services.
 */
@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Turn a Lead into an Opportunity: ensure the lead has a Customer (reusing its
   * converted customer, or creating one from the lead), open an Opportunity against
   * that customer linked back to the lead, and stamp the lead with both.
   */
  async makeOpportunity(lead: string, ctx?: UserContext): Promise<string> {
    const leadDt = this.registry.get("Lead");
    const oppDt = this.registry.get("Opportunity");
    const custDt = this.registry.get("Customer");
    if (!leadDt || !oppDt || !custDt) throw new BadRequestException("Lead/Opportunity/Customer not registered");
    const context = ctx ?? systemContext();
    const row = await this.documents.get(leadDt, lead);
    if (row.opportunity) throw new BadRequestException(`Lead ${lead} already has Opportunity ${row.opportunity}`);

    const customer = await this.ensureCustomer(row, context);
    const opportunity = await this.documents.create(oppDt, context, {
      customer,
      lead,
      status: "Open",
      sales_stage: "Prospecting",
      opportunity_amount: 0,
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Lead"))}
       SET ${quoteIdent("opportunity")} = $1, ${quoteIdent("customer")} = $2, ${quoteIdent("status")} = 'Qualified'
       WHERE ${quoteIdent("name")} = $3`,
      [String(opportunity.name), customer, lead],
    );
    this.logger.log(`Lead ${lead} -> Opportunity ${opportunity.name} (customer ${customer})`);
    return String(opportunity.name);
  }

  /**
   * Turn an Opportunity into a draft Quotation: copy the customer and any
   * Opportunity Items onto a new Quotation linked back to the opportunity, then
   * stamp the opportunity with the quotation and advance its status to Quotation.
   */
  async makeQuotation(opportunity: string, ctx?: UserContext): Promise<string> {
    const oppDt = this.registry.get("Opportunity");
    const qtnDt = this.registry.get("Quotation");
    if (!oppDt || !qtnDt) throw new BadRequestException("Opportunity or Quotation not registered");
    const context = ctx ?? systemContext();
    const opp = await this.documents.get(oppDt, opportunity);
    if (opp.quotation) throw new BadRequestException(`Opportunity ${opportunity} already has Quotation ${opp.quotation}`);

    const items = ((opp.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      rate: Number(r.rate ?? 0),
    }));
    const today = new Date().toISOString().slice(0, 10);
    const qtn = await this.documents.create(qtnDt, context, {
      customer: opp.customer,
      transaction_date: today,
      opportunity,
      items,
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Opportunity"))}
       SET ${quoteIdent("quotation")} = $1, ${quoteIdent("status")} = 'Quotation'
       WHERE ${quoteIdent("name")} = $2`,
      [String(qtn.name), opportunity],
    );
    this.logger.log(`Opportunity ${opportunity} -> Quotation ${qtn.name}`);
    return String(qtn.name);
  }

  /**
   * Close an Opportunity Won or Lost. Won marks it Converted / Closed Won; Lost
   * marks it Lost / Closed Lost and records the (required) lost reason. An
   * Opportunity already Lost or Converted cannot be re-closed.
   */
  async closeOpportunity(
    opportunity: string,
    outcome: "Won" | "Lost",
    reason: string,
    ctx?: UserContext,
  ): Promise<{ status: string; sales_stage: string }> {
    const oppDt = this.registry.get("Opportunity");
    if (!oppDt) throw new BadRequestException("Opportunity not registered");
    void ctx;
    const opp = await this.documents.get(oppDt, opportunity);
    const current = String(opp.status ?? "Open");
    if (current === "Lost" || current === "Converted") {
      throw new BadRequestException(`Opportunity ${opportunity} is already ${current}`);
    }
    if (outcome !== "Won" && outcome !== "Lost") {
      throw new BadRequestException(`Outcome must be Won or Lost (got ${outcome})`);
    }
    if (outcome === "Lost" && !String(reason ?? "").trim()) {
      throw new BadRequestException("A lost reason is required to close an Opportunity as Lost");
    }
    const status = outcome === "Won" ? "Converted" : "Lost";
    const salesStage = outcome === "Won" ? "Closed Won" : "Closed Lost";
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Opportunity"))}
       SET ${quoteIdent("status")} = $1, ${quoteIdent("sales_stage")} = $2, ${quoteIdent("lost_reason")} = $3
       WHERE ${quoteIdent("name")} = $4`,
      [status, salesStage, outcome === "Lost" ? String(reason).trim() : null, opportunity],
    );
    this.logger.log(`Opportunity ${opportunity} closed ${outcome} (${salesStage})`);
    return { status, sales_stage: salesStage };
  }

  /** Reuse the lead's converted customer, else create one named after the lead. */
  private async ensureCustomer(lead: Record<string, unknown>, ctx: UserContext): Promise<string> {
    if (lead.customer) return String(lead.customer);
    const custDt = this.registry.get("Customer");
    if (!custDt) throw new BadRequestException("Customer not registered");
    const name = String(lead.lead_name);
    try {
      const created = await this.documents.create(custDt, ctx, {
        customer_name: name,
        territory: lead.territory ?? null,
        email_id: lead.email_id ?? null,
        mobile_no: lead.mobile_no ?? null,
      });
      return String(created.name);
    } catch (err) {
      if ((err as { status?: number }).status === 409) return name; // already exists → named by customer_name
      throw err;
    }
  }
}
