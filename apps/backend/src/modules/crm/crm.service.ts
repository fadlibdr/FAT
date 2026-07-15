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
