import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

interface Term {
  description: string;
  invoice_portion: number;
  credit_days: number;
}

/**
 * Expands a Payment Terms Template into an invoice's payment_schedule before the
 * document is written. For any Sales/Purchase Invoice carrying a
 * `payment_terms_template` and no explicit schedule, each template term produces
 * a due-dated installment (posting_date + credit_days) for its portion of the
 * invoice total (net + taxes); the final row absorbs any rounding remainder so
 * the installments sum exactly to the total. Pure before_save listener.
 */
@Injectable()
export class PaymentTermsListener {
  private readonly logger = new Logger(PaymentTermsListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save")
  async onBeforeSave(payload: BeforeSavePayload): Promise<void> {
    const data = payload.data;
    if (!data.payment_terms_template || !this.registry.has("Payment Terms Template")) return;
    const dt = this.registry.get(payload.doctype);
    if (!dt || !dt.fields.some((f) => f.fieldname === "payment_schedule")) return;
    // Respect an explicitly-provided schedule.
    const existing = data.payment_schedule as unknown[] | undefined;
    if (Array.isArray(existing) && existing.length > 0) return;

    const terms = await this.loadTerms(String(data.payment_terms_template));
    if (terms.length === 0) return;

    const base = this.invoiceTotal(data);
    if (base <= 0) return;
    const posting = data.posting_date ? new Date(data.posting_date as string) : new Date(NaN);

    const rows: Array<Record<string, unknown>> = [];
    let allocated = 0;
    terms.forEach((t, i) => {
      const isLast = i === terms.length - 1;
      const amount = isLast
        ? Math.round((base - allocated) * 100) / 100
        : Math.round(base * (t.invoice_portion / 100) * 100) / 100;
      allocated += amount;
      rows.push({
        due_date: this.addDays(posting, t.credit_days),
        invoice_portion: t.invoice_portion,
        payment_amount: amount,
        description: t.description ?? null,
      });
    });
    data.payment_schedule = rows;
    this.logger.log(
      `Payment schedule for ${payload.doctype}: ${rows.length} installment(s) totalling ${base}`,
    );
  }

  /** Net (Σ qty×rate) + taxes (rate % of net, else explicit tax_amount). */
  private invoiceTotal(data: Record<string, unknown>): number {
    const items = (data.items as Array<Record<string, unknown>>) ?? [];
    const net = items.reduce((s, r) => s + Number(r.qty ?? 0) * Number(r.rate ?? 0), 0);
    const taxes = (data.taxes as Array<Record<string, unknown>>) ?? [];
    const totalTax = taxes.reduce((s, t) => {
      const rate = Number(t.rate ?? 0);
      return s + (rate ? (net * rate) / 100 : Number(t.tax_amount ?? 0));
    }, 0);
    return net + totalTax;
  }

  private addDays(date: Date, days: number): string | null {
    if (Number.isNaN(date.getTime())) return null;
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + Number(days || 0));
    return d.toISOString().slice(0, 10);
  }

  private async loadTerms(template: string): Promise<Term[]> {
    return this.dataSource.query(
      `SELECT ${quoteIdent("description")} AS description,
              coalesce(${quoteIdent("invoice_portion")},0) AS invoice_portion,
              coalesce(${quoteIdent("credit_days")},0) AS credit_days
       FROM ${quoteIdent(tableNameFor("Payment Terms Template Detail"))}
       WHERE ${quoteIdent("parent")} = $1 ORDER BY ${quoteIdent("idx")}`,
      [template],
    );
  }
}
