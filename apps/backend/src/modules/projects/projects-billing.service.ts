import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

const BILLING_ITEM = "Timesheet Billing";

/**
 * Timesheet billing: turn a submitted billable Timesheet into a draft Sales
 * Invoice for its project's customer, one line of hours × billing rate against a
 * service item. Stamps the timesheet with the invoice and rolls the project's
 * billed amount. Created through the generic DocumentService — projects imports no
 * other module's services.
 */
@Injectable()
export class ProjectsBillingService {
  private readonly logger = new Logger(ProjectsBillingService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async makeSalesInvoice(timesheet: string, ctx?: UserContext): Promise<string> {
    const tsDt = this.registry.get("Timesheet");
    const siDt = this.registry.get("Sales Invoice");
    const projDt = this.registry.get("Project");
    if (!tsDt || !siDt || !projDt) throw new BadRequestException("Timesheet/Sales Invoice/Project not registered");
    const context = ctx ?? systemContext();
    const ts = await this.documents.get(tsDt, timesheet);
    if ((ts.docstatus ?? 0) !== 1) throw new BadRequestException("Timesheet must be submitted");
    if (Number(ts.is_billable ?? 0) !== 1) throw new BadRequestException(`Timesheet ${timesheet} is not billable`);
    if (ts.sales_invoice) throw new BadRequestException(`Timesheet ${timesheet} already billed via ${ts.sales_invoice}`);

    const project = String(ts.project ?? "");
    if (!project) throw new BadRequestException(`Timesheet ${timesheet} has no project to bill`);
    const proj = await this.documents.get(projDt, project);
    const customer = String(proj.customer ?? "");
    if (!customer) throw new BadRequestException(`Project ${project} has no customer to bill`);

    const hours = Number(ts.hours ?? 0);
    const rate = Number(ts.billing_rate ?? 0);
    const amount = Number(ts.billable_amount ?? hours * rate);
    if (amount <= 0) throw new BadRequestException(`Timesheet ${timesheet} has nothing billable`);

    const item = await this.ensureBillingItem(context);
    const invoice = await this.documents.create(siDt, context, {
      customer,
      posting_date: new Date().toISOString().slice(0, 10),
      project,
      items: [{ item_code: item, qty: hours, rate }],
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Timesheet"))}
       SET ${quoteIdent("sales_invoice")} = $1 WHERE ${quoteIdent("name")} = $2`,
      [String(invoice.name), timesheet],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Project"))}
       SET ${quoteIdent("total_billed_amount")} = coalesce(${quoteIdent("total_billed_amount")}, 0) + $1
       WHERE ${quoteIdent("name")} = $2`,
      [amount, project],
    );
    this.logger.log(`Timesheet ${timesheet} -> Sales Invoice ${invoice.name} (${customer}, ${amount})`);
    return String(invoice.name);
  }

  /** Reuse the shared service item, creating it once if it does not yet exist. */
  private async ensureBillingItem(ctx: UserContext): Promise<string> {
    const itemDt = this.registry.get("Item");
    if (!itemDt) throw new BadRequestException("Item not registered");
    try {
      const created = await this.documents.create(itemDt, ctx, {
        item_code: BILLING_ITEM,
        item_name: BILLING_ITEM,
        stock_uom: "Nos",
        is_stock_item: 0,
      });
      return String(created.name);
    } catch (err) {
      if ((err as { status?: number }).status === 409) return BILLING_ITEM; // already exists
      throw err;
    }
  }
}
