import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Sales Target tracking. A Sales Target sets a sales person's revenue goal for a
 * date window; each submitted Sales Invoice for that person, dated inside the
 * window, accrues its net (Σ qty × rate) into the target's achieved amount, and a
 * cancel reverses it. Pure event-bus listener; the invoice net is computed from
 * the line items (not the async-computed grand total) so accrual is deterministic
 * at submit time. No cross-module service imports.
 */
@Injectable()
export class SalesTargetListener {
  private readonly logger = new Logger(SalesTargetListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private isoDay(value: unknown): string {
    if (!value) return "";
    if (value instanceof Date) {
      const y = value.getUTCFullYear();
      const m = String(value.getUTCMonth() + 1).padStart(2, "0");
      const d = String(value.getUTCDate()).padStart(2, "0");
      return `${y}-${m}-${d}`;
    }
    return String(value).slice(0, 10);
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Sales Target", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const doc = payload.doc;
    if (!doc.sales_person) throw new BadRequestException("A sales person is required");
    if (Number(doc.target_amount ?? 0) <= 0) {
      throw new BadRequestException(`Sales Target ${doc.name}: target amount must be greater than zero`);
    }
    const from = this.isoDay(doc.from_date);
    const to = this.isoDay(doc.to_date);
    if (from && to && from > to) {
      throw new BadRequestException(`Sales Target ${doc.name}: from date ${from} is after to date ${to}`);
    }
  }

  @OnEvent("doc.on_submit:Sales Invoice")
  async onInvoiceSubmit(payload: DocEventPayload): Promise<void> {
    await this.accrue(payload.doc, 1);
  }

  @OnEvent("doc.on_cancel:Sales Invoice")
  async onInvoiceCancel(payload: DocEventPayload): Promise<void> {
    await this.accrue(payload.doc, -1);
  }

  private async accrue(doc: Record<string, unknown>, sign: 1 | -1): Promise<void> {
    if (!this.registry.has("Sales Target")) return;
    const person = String(doc.sales_person ?? "");
    if (!person || Boolean(doc.is_return)) return;
    const posting = this.isoDay(doc.posting_date);
    if (!posting) return;
    const net = ((doc.items as Array<Record<string, unknown>>) ?? []).reduce(
      (s, r) => s + Number(r.qty ?? 0) * Number(r.rate ?? 0),
      0,
    );
    if (net <= 0) return;
    const delta = Math.round(sign * net * 100) / 100;
    const res = await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Sales Target"))}
       SET ${quoteIdent("achieved_amount")} = coalesce(${quoteIdent("achieved_amount")}, 0) + $1
       WHERE ${quoteIdent("sales_person")} = $2 AND ${quoteIdent("docstatus")} = 1
         AND ${quoteIdent("from_date")} <= $3 AND ${quoteIdent("to_date")} >= $3
       RETURNING ${quoteIdent("name")}`,
      [delta, person, posting],
    );
    const names = (res as Array<{ name: string }>).map((r) => r.name);
    if (names.length) {
      this.logger.log(
        `Sales Target: ${sign > 0 ? "accrued" : "reversed"} ${net} for ${person} on ${posting} -> ${names.join(", ")}`,
      );
    }
  }
}
