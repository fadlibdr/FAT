import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Tax templates. When a Sales/Purchase Invoice or Order names a taxes template and
 * carries no tax rows of its own, its `taxes` child is populated from the template
 * (account head, rate, description); the recompute-totals job then fills each
 * tax_amount and the grand total. Pure event-bus listener — reads the template via
 * SQL, no cross-module service imports.
 */
@Injectable()
export class TaxTemplateListener {
  private readonly logger = new Logger(TaxTemplateListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save:Sales Invoice")
  async onSalesInvoice(payload: BeforeSavePayload): Promise<void> {
    await this.apply(payload, "Sales Taxes Template", "Sales Taxes and Charges");
  }

  @OnEvent("doc.before_save:Sales Order")
  async onSalesOrder(payload: BeforeSavePayload): Promise<void> {
    await this.apply(payload, "Sales Taxes Template", "Sales Taxes and Charges");
  }

  @OnEvent("doc.before_save:Purchase Invoice")
  async onPurchaseInvoice(payload: BeforeSavePayload): Promise<void> {
    await this.apply(payload, "Purchase Taxes Template", "Purchase Taxes and Charges");
  }

  @OnEvent("doc.before_save:Purchase Order")
  async onPurchaseOrder(payload: BeforeSavePayload): Promise<void> {
    await this.apply(payload, "Purchase Taxes Template", "Purchase Taxes and Charges");
  }

  private async apply(payload: BeforeSavePayload, templateDoctype: string, childDoctype: string): Promise<void> {
    const d = payload.data;
    if (!d.taxes_template || !this.registry.has(templateDoctype)) return;
    const existing = (d.taxes as Array<Record<string, unknown>>) ?? [];
    if (existing.length > 0) return; // explicit taxes win over the template
    const rows = await this.templateTaxes(String(d.taxes_template), childDoctype);
    if (rows.length === 0) return;
    d.taxes = rows.map((r) => ({
      account_head: r.account_head,
      rate: Number(r.rate ?? 0),
      description: r.description ?? null,
    }));
    this.logger.log(`Applied ${templateDoctype} ${d.taxes_template} (${rows.length} rows)`);
  }

  private async templateTaxes(template: string, childDoctype: string): Promise<Array<Record<string, unknown>>> {
    if (!this.registry.has(childDoctype)) return [];
    return this.dataSource.query(
      `SELECT ${quoteIdent("account_head")} AS account_head, ${quoteIdent("rate")} AS rate,
              ${quoteIdent("description")} AS description
       FROM ${quoteIdent(tableNameFor(childDoctype))}
       WHERE ${quoteIdent("parent")} = $1 AND ${quoteIdent("parentfield")} = 'taxes'
       ORDER BY ${quoteIdent("idx")}`,
      [template],
    );
  }
}
