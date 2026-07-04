import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

const DEBTORS = "Debtors";
const SALES = "Sales";
const CASH = "Cash";
const CREDITORS = "Creditors";

interface Line {
  account: string;
  debit: number;
  credit: number;
  against: string;
  cost_center?: string | null;
}

/**
 * Posts double-entry GL for accounting vouchers in the base currency, splitting
 * income and tax accounts, and reconciles Payment Entries against Sales Invoices
 * (outstanding + status). Pure event-bus listener — no cross-module imports.
 */
@Injectable()
export class GlPostingListener {
  private readonly logger = new Logger(GlPostingListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async postLines(
    ctx: UserContext,
    voucherType: string,
    voucherNo: string,
    postingDate: unknown,
    lines: Line[],
  ): Promise<void> {
    const dt = this.registry.get("GL Entry");
    if (!dt) return;
    for (const l of lines) {
      if (!l.debit && !l.credit) continue;
      await this.documents.create(dt, ctx, {
        posting_date: postingDate ?? null,
        voucher_type: voucherType,
        voucher_no: voucherNo,
        account: l.account,
        debit: l.debit,
        credit: l.credit,
        against: l.against,
        cost_center: l.cost_center ?? null,
      });
    }
  }

  private async reverseGl(voucherType: string, voucherNo: unknown): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      [voucherType, voucherNo],
    );
  }

  private async setInvoice(name: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    const params = [...Object.values(fields), name];
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Sales Invoice"))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${params.length}`,
      params,
    );
  }

  @OnEvent("doc.on_submit:Sales Invoice")
  async onInvoiceSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const conv = Number(doc.conversion_rate ?? 1) || 1;
    const net = Number(doc.total ?? 0);
    const grand = Number(doc.grand_total ?? net);
    const against = String(doc.customer ?? "");
    const cc = (doc.cost_center as string) || null;
    const ctx = systemContext(payload.user);

    const lines: Line[] = [
      { account: DEBTORS, debit: grand * conv, credit: 0, against, cost_center: cc },
      { account: SALES, debit: 0, credit: net * conv, against, cost_center: cc },
    ];
    for (const t of (doc.taxes as Array<Record<string, unknown>>) ?? []) {
      const amt = Number(t.tax_amount ?? 0);
      if (!amt) continue;
      const acct = (t.account_head as string) || SALES;
      lines.push({ account: acct, debit: 0, credit: amt * conv, against, cost_center: cc });
    }
    try {
      await this.postLines(ctx, "Sales Invoice", String(doc.name), doc.posting_date, lines);
      await this.setInvoice(String(doc.name), {
        base_grand_total: grand * conv,
        outstanding_amount: grand,
        status: "Unpaid",
      });
      this.logger.log(`Posted GL for Sales Invoice ${doc.name} (base ${grand * conv})`);
    } catch (err) {
      this.logger.error(`Failed GL for ${doc.name}: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Sales Invoice")
  async onInvoiceCancel(payload: DocEventPayload): Promise<void> {
    await this.reverseGl("Sales Invoice", payload.doc.name);
    await this.setInvoice(String(payload.doc.name), { status: "Cancelled", outstanding_amount: 0 });
  }

  @OnEvent("doc.on_submit:Payment Entry")
  async onPaymentSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const conv = Number(doc.conversion_rate ?? 1) || 1;
    const paid = Number(doc.paid_amount ?? 0);
    const base = paid * conv;
    const receive = String(doc.payment_type ?? "Receive") === "Receive";
    const [debit, credit] = receive ? [CASH, DEBTORS] : [CREDITORS, CASH];
    const ctx = systemContext(payload.user);
    try {
      await this.postLines(ctx, "Payment Entry", String(doc.name), doc.posting_date, [
        { account: debit, debit: base, credit: 0, against: String(doc.party ?? "") },
        { account: credit, debit: 0, credit: base, against: String(doc.party ?? "") },
      ]);
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Payment Entry"))} SET ${quoteIdent("base_paid_amount")} = $1
         WHERE ${quoteIdent("name")} = $2`,
        [base, doc.name],
      );
      // Reconcile against referenced invoices.
      for (const r of (doc.references as Array<Record<string, unknown>>) ?? []) {
        if (String(r.reference_doctype) !== "Sales Invoice" || !r.reference_name) continue;
        const alloc = Number(r.allocated_amount ?? 0);
        const inv = (
          await this.dataSource.query(
            `SELECT ${quoteIdent("outstanding_amount")} AS o FROM ${quoteIdent(tableNameFor("Sales Invoice"))}
             WHERE ${quoteIdent("name")} = $1`,
            [r.reference_name],
          )
        )[0];
        const outstanding = Math.max(0, Number(inv?.o ?? 0) - alloc);
        await this.setInvoice(String(r.reference_name), {
          outstanding_amount: outstanding,
          status: outstanding <= 0.0001 ? "Paid" : "Unpaid",
        });
      }
      this.logger.log(`Posted GL + reconciled Payment Entry ${doc.name} (base ${base})`);
    } catch (err) {
      this.logger.error(`Failed GL for ${doc.name}: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Payment Entry")
  async onPaymentCancel(payload: DocEventPayload): Promise<void> {
    await this.reverseGl("Payment Entry", payload.doc.name);
    // Restore outstanding on referenced invoices.
    for (const r of (payload.doc.references as Array<Record<string, unknown>>) ?? []) {
      if (String(r.reference_doctype) !== "Sales Invoice" || !r.reference_name) continue;
      const alloc = Number(r.allocated_amount ?? 0);
      const inv = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("outstanding_amount")} AS o FROM ${quoteIdent(tableNameFor("Sales Invoice"))}
           WHERE ${quoteIdent("name")} = $1`,
          [r.reference_name],
        )
      )[0];
      await this.setInvoice(String(r.reference_name), {
        outstanding_amount: Number(inv?.o ?? 0) + alloc,
        status: "Unpaid",
      });
    }
  }
}
