import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Commission payout. The Salesteam listener accrues each sales person's
 * `total_commission` as invoices are submitted; a Commission Payout settles some
 * of that accrual, booking Dr Commission Expense / Cr Commission Payable and
 * tracking how much has been paid. Pure event-bus listener — no cross-module
 * service imports.
 *
 *  1. before_submit gates the payout against the unpaid accrual.
 *  2. on_submit posts the GL and bumps the sales person's paid_commission.
 *  3. on_cancel reverses both.
 */
@Injectable()
export class CommissionPayoutListener {
  private readonly logger = new Logger(CommissionPayoutListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async person(name: string): Promise<Record<string, unknown> | undefined> {
    if (!name || !this.registry.has("Sales Person")) return undefined;
    return (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name,
                coalesce(${quoteIdent("total_commission")}, 0) AS accrued,
                coalesce(${quoteIdent("paid_commission")}, 0) AS paid
         FROM ${quoteIdent(tableNameFor("Sales Person"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
  }

  // suppressErrors:false so the over-payment gate aborts the submit.
  @OnEvent("doc.before_submit:Commission Payout", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const person = await this.person(String(doc.sales_person ?? ""));
    if (!person) throw new BadRequestException(`Sales Person ${doc.sales_person} not found`);
    const amount = Number(doc.commission_amount ?? 0);
    const accrued = Number(person.accrued ?? 0);
    const paid = Number(person.paid ?? 0);
    if (round2(paid + amount) > round2(accrued) + 0.0001) {
      throw new BadRequestException(
        `Commission Payout ${doc.name}: ${amount} exceeds unpaid commission ` +
          `${round2(accrued - paid)} (accrued ${accrued}, already paid ${paid})`,
      );
    }
  }

  @OnEvent("doc.on_submit:Commission Payout")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const dt = this.registry.get("GL Entry");
    const person = await this.person(String(doc.sales_person ?? ""));
    if (!dt || !person) return;
    const ctx = systemContext(payload.user);
    const amount = Number(doc.commission_amount ?? 0);
    if (amount <= 0) return;
    const expense = String(doc.expense_account || "Commission Expense");
    const payable = String(doc.payable_account || "Commission Payable");
    const against = String(doc.sales_person ?? "");
    try {
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Commission Payout",
        voucher_no: String(doc.name), account: expense, debit: amount, credit: 0, against,
      });
      await this.documents.create(dt, ctx, {
        posting_date: doc.posting_date ?? null, voucher_type: "Commission Payout",
        voucher_no: String(doc.name), account: payable, debit: 0, credit: amount, against,
      });
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Sales Person"))}
         SET ${quoteIdent("paid_commission")} = $1 WHERE ${quoteIdent("name")} = $2`,
        [round2(Number(person.paid ?? 0) + amount), String(person.name)],
      );
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Commission Payout"))} SET ${quoteIdent("status")} = 'Submitted'
         WHERE ${quoteIdent("name")} = $1`,
        [String(doc.name)],
      );
      this.logger.log(`Commission Payout ${doc.name}: ${amount} to ${against} (Dr ${expense} / Cr ${payable})`);
    } catch (err) {
      this.logger.error(`Commission Payout ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Commission Payout")
  async onCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = 'Commission Payout' AND ${quoteIdent("voucher_no")} = $1`,
        [String(doc.name)],
      );
    }
    const person = await this.person(String(doc.sales_person ?? ""));
    if (person) {
      const back = round2(Number(person.paid ?? 0) - Number(doc.commission_amount ?? 0));
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Sales Person"))}
         SET ${quoteIdent("paid_commission")} = $1 WHERE ${quoteIdent("name")} = $2`,
        [back < 0 ? 0 : back, String(person.name)],
      );
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Commission Payout"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(doc.name)],
    );
  }
}
