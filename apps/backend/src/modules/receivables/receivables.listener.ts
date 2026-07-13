import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const DEBTORS = "Debtors";
const INTEREST_INCOME = "Interest Income";

/**
 * Accounts-receivable collections. Pure event-bus behaviours, no cross-module
 * service imports:
 *
 *  1. before_save on a Dunning computes the interest charged on an overdue
 *     invoice (outstanding × rate% × overdue_days / 365).
 *  2. on_submit/on_cancel on a Dunning books that interest as income
 *     (Dr Debtors / Cr Interest Income) and reverses it on cancel.
 *  3. before_submit on a Sales Invoice gates the transition against the
 *     customer's credit limit: existing open receivable + this invoice must not
 *     exceed Customer.credit_limit (0 / unset = no limit).
 */
@Injectable()
export class ReceivablesListener {
  private readonly logger = new Logger(ReceivablesListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private round(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  @OnEvent("doc.before_save:Dunning")
  onDunningSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    const outstanding = Number(d.outstanding_amount ?? 0);
    const rate = Number(d.interest_rate ?? 0);
    const days = Number(d.overdue_days ?? 0);
    d.interest_amount = this.round((outstanding * rate * days) / (100 * 365));
  }

  @OnEvent("doc.on_submit:Dunning")
  async onDunningSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const interest = Number(doc.interest_amount ?? 0);
    if (interest <= 0) {
      await this.setDoc("Dunning", String(doc.name), { status: "Unresolved" });
      return;
    }
    const debtor = String(doc.debtor_account || DEBTORS);
    const income = String(doc.income_account || INTEREST_INCOME);
    const against = String(doc.customer ?? "");
    const ctx = systemContext(payload.user);
    try {
      await this.postLines(ctx, "Dunning", String(doc.name), doc.posting_date, [
        { account: debtor, debit: interest, credit: 0, against },
        { account: income, debit: 0, credit: interest, against },
      ]);
      await this.setDoc("Dunning", String(doc.name), { status: "Unresolved" });
      this.logger.log(`Dunning ${doc.name}: booked interest ${interest} (Dr ${debtor} / Cr ${income})`);
    } catch (err) {
      this.logger.error(`Dunning ${doc.name} GL failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Dunning")
  async onDunningCancel(payload: DocEventPayload): Promise<void> {
    await this.reverseGl("Dunning", payload.doc.name);
    await this.setDoc("Dunning", String(payload.doc.name), { status: "Cancelled" });
  }

  // suppressErrors:false so a thrown gate error rejects emitAsync and aborts the
  // submit, rather than being swallowed and logged by the event emitter.
  @OnEvent("doc.before_submit:Sales Invoice", { suppressErrors: false })
  async gateCreditLimit(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Customer")) return;
    const doc = payload.doc;
    if (Boolean(doc.is_return)) return; // credit notes reduce exposure
    const customer = String(doc.customer ?? "");
    if (!customer) return;
    const limit = await this.creditLimitOf(customer);
    if (limit <= 0) return; // unset / zero = no limit enforced

    const existing = await this.openReceivableOf(customer);
    const thisInvoice = Number(doc.grand_total ?? doc.total ?? 0);
    const exposure = this.round(existing + thisInvoice);
    if (exposure > limit) {
      throw new BadRequestException(
        `Sales Invoice ${doc.name}: customer ${customer} credit limit ${limit} exceeded ` +
          `(open ${this.round(existing)} + this ${this.round(thisInvoice)} = ${exposure})`,
      );
    }
    this.logger.log(`Sales Invoice ${doc.name} passed credit gate (${exposure} <= ${limit})`);
  }

  private async creditLimitOf(customer: string): Promise<number> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("credit_limit")} AS lim
         FROM ${quoteIdent(tableNameFor("Customer"))} WHERE ${quoteIdent("name")} = $1`,
        [customer],
      )
    )[0];
    return Number(row?.lim ?? 0);
  }

  /** Sum of outstanding on the customer's already-submitted sales invoices. */
  private async openReceivableOf(customer: string): Promise<number> {
    if (!this.registry.has("Sales Invoice")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("outstanding_amount")}), 0) AS o
         FROM ${quoteIdent(tableNameFor("Sales Invoice"))}
         WHERE ${quoteIdent("customer")} = $1 AND ${quoteIdent("docstatus")} = 1`,
        [customer],
      )
    )[0];
    return Number(row?.o ?? 0);
  }

  private async postLines(
    ctx: ReturnType<typeof systemContext>,
    voucherType: string,
    voucherNo: string,
    postingDate: unknown,
    lines: { account: string; debit: number; credit: number; against: string }[],
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

  private async setDoc(
    doctype: string,
    name: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    const params = [...Object.values(fields), name];
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${params.length}`,
      params,
    );
  }
}
