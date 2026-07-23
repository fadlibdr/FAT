import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Recurring billing. A daily cron (also runnable on demand) finds Active
 * Subscriptions whose next_invoice_date has arrived, raises and submits a Sales
 * Invoice from the plan's item/price, then advances next_invoice_date by the
 * plan's interval and records the run. Reuses the generic DocumentService, so
 * the invoice posts GL through the normal event path — no cross-module imports.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async scheduled(): Promise<void> {
    const n = await this.generateDueInvoices();
    if (n > 0) this.logger.log(`Subscription billing: generated ${n} invoice(s)`);
  }

  // suppressErrors:false so an inverted date window aborts the save.
  @OnEvent("doc.before_save:Subscription", { suppressErrors: false })
  gateDates(payload: BeforeSavePayload): void {
    const d = payload.data;
    const start = d.start_date ? String(d.start_date) : "";
    const end = d.end_date ? String(d.end_date) : "";
    if (start && end && end < start) {
      throw new BadRequestException("End Date cannot be before Start Date");
    }
  }

  /** Stop a subscription's billing. Only an Active subscription can be cancelled. */
  async cancel(name: string): Promise<{ subscription: string; status: string }> {
    const subDt = this.registry.get("Subscription");
    if (!subDt) throw new BadRequestException("Subscription not registered");
    const sub = await this.documents.get(subDt, name);
    if (String(sub.status) !== "Active") {
      throw new BadRequestException(`Subscription ${name} is ${sub.status}, not Active`);
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Subscription"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [name],
    );
    this.logger.log(`Subscription ${name}: cancelled`);
    return { subscription: name, status: "Cancelled" };
  }

  /** Poll a freshly-created invoice until its derived grand_total is ready. */
  private async waitForTotals(invDt: ReturnType<DoctypeRegistryService["get"]>, name: string, expected: number): Promise<void> {
    if (!invDt || expected <= 0) return;
    for (let i = 0; i < 60; i += 1) {
      const inv = await this.documents.get(invDt, name);
      if (Number(inv.grand_total ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private advance(date: Date, interval: string, count: number): Date {
    const d = new Date(date.getTime());
    const n = Math.max(1, count || 1);
    if (interval === "Day") d.setDate(d.getDate() + n);
    else if (interval === "Week") d.setDate(d.getDate() + 7 * n);
    else d.setMonth(d.getMonth() + n); // Month
    return d;
  }

  /** Bill every Active subscription whose next_invoice_date is due. Returns count. */
  async generateDueInvoices(asOf?: string): Promise<number> {
    const subDt = this.registry.get("Subscription");
    const planDt = this.registry.get("Subscription Plan");
    const invDt = this.registry.get("Sales Invoice");
    if (!subDt || !planDt || !invDt) return 0;
    const ctx = systemContext();
    const today = asOf ?? new Date().toISOString().slice(0, 10);

    const due = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Subscription"))}
       WHERE ${quoteIdent("status")} = 'Active'
         AND ${quoteIdent("next_invoice_date")} IS NOT NULL
         AND ${quoteIdent("next_invoice_date")} <= $1
         AND (${quoteIdent("end_date")} IS NULL OR ${quoteIdent("next_invoice_date")} <= ${quoteIdent("end_date")})`,
      [today],
    );

    let generated = 0;
    for (const row of due) {
      try {
        const sub = await this.documents.get(subDt, String(row.name));
        const plan = await this.documents.get(planDt, String(sub.plan));
        // Date columns come back as JS Date objects — normalise to YYYY-MM-DD.
        const postingDate = new Date(sub.next_invoice_date as string).toISOString().slice(0, 10);

        const invoice = await this.documents.create(invDt, ctx, {
          customer: sub.customer,
          posting_date: postingDate,
          due_date: postingDate,
          company: sub.company ?? null,
          items: [{ item_code: plan.item, qty: 1, rate: plan.price }],
        });
        // Grand total is derived by the async recompute-totals job (a separate
        // worker when Redis is enabled); wait for it before submitting so GL
        // posts the real amount rather than zero.
        await this.waitForTotals(invDt, String(invoice.name), Number(plan.price ?? 0));
        await this.documents.setDocStatus(invDt, ctx, String(invoice.name), 1);

        const next = this.advance(
          new Date(postingDate),
          String(plan.billing_interval ?? "Month"),
          Number(plan.interval_count ?? 1),
        );
        const nextStr = next.toISOString().slice(0, 10);
        // If the next cycle falls beyond the end date, the subscription is done.
        const endStr = sub.end_date ? new Date(sub.end_date as string).toISOString().slice(0, 10) : "";
        const completed = endStr && nextStr > endStr;
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Subscription"))}
           SET ${quoteIdent("next_invoice_date")} = $1,
               ${quoteIdent("invoice_count")} = coalesce(${quoteIdent("invoice_count")},0) + 1,
               ${quoteIdent("last_invoice")} = $2,
               ${quoteIdent("status")} = $4
           WHERE ${quoteIdent("name")} = $3`,
          [nextStr, invoice.name, sub.name, completed ? "Completed" : "Active"],
        );
        generated += 1;
        this.logger.log(
          `Subscription ${sub.name}: invoiced ${invoice.name}, next ${nextStr}${completed ? " (completed)" : ""}`,
        );
      } catch (err) {
        this.logger.error(`Subscription ${row.name} billing failed: ${(err as Error).message}`);
      }
    }
    return generated;
  }
}
