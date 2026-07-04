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

/**
 * Posts double-entry GL Entries on submit of accounting vouchers and reverses
 * them on cancel. Accounting only listens on the document event bus, never
 * importing Selling — the dependency stays one-directional.
 */
@Injectable()
export class GlPostingListener {
  private readonly logger = new Logger(GlPostingListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Post a balanced debit/credit pair for a voucher. */
  private async postPair(
    ctx: UserContext,
    voucherType: string,
    voucherNo: string,
    postingDate: unknown,
    against: string,
    debitAccount: string,
    creditAccount: string,
    amount: number,
  ): Promise<void> {
    const dt = this.registry.get("GL Entry");
    if (!dt || !amount) return;
    const common = {
      posting_date: postingDate ?? null,
      voucher_type: voucherType,
      voucher_no: voucherNo,
      against,
    };
    await this.documents.create(dt, ctx, { ...common, account: debitAccount, debit: amount, credit: 0 });
    await this.documents.create(dt, ctx, { ...common, account: creditAccount, debit: 0, credit: amount });
  }

  private async reverse(voucherType: string, voucherNo: unknown): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      [voucherType, voucherNo],
    );
  }

  @OnEvent("doc.on_submit:Sales Invoice")
  async onInvoiceSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = Number(doc.grand_total ?? doc.total ?? 0);
    try {
      await this.postPair(
        systemContext(payload.user),
        "Sales Invoice",
        String(doc.name),
        doc.posting_date,
        String(doc.customer ?? ""),
        DEBTORS,
        SALES,
        amount,
      );
      this.logger.log(`Posted GL for Sales Invoice ${doc.name} (${amount})`);
    } catch (err) {
      this.logger.error(`Failed GL for ${doc.name}: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_submit:Payment Entry")
  async onPaymentSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = Number(doc.paid_amount ?? 0);
    const receive = String(doc.payment_type ?? "Receive") === "Receive";
    // Receive: Dr Cash / Cr Debtors. Pay: Dr Creditors / Cr Cash.
    const [debit, credit] = receive ? [CASH, DEBTORS] : [CREDITORS, CASH];
    try {
      await this.postPair(
        systemContext(payload.user),
        "Payment Entry",
        String(doc.name),
        doc.posting_date,
        String(doc.party ?? ""),
        debit,
        credit,
        amount,
      );
      this.logger.log(`Posted GL for Payment Entry ${doc.name} (${amount})`);
    } catch (err) {
      this.logger.error(`Failed GL for ${doc.name}: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Sales Invoice")
  async onInvoiceCancel(payload: DocEventPayload): Promise<void> {
    await this.reverse("Sales Invoice", payload.doc.name);
    this.logger.log(`Reversed GL for cancelled Sales Invoice ${payload.doc.name}`);
  }

  @OnEvent("doc.on_cancel:Payment Entry")
  async onPaymentCancel(payload: DocEventPayload): Promise<void> {
    await this.reverse("Payment Entry", payload.doc.name);
    this.logger.log(`Reversed GL for cancelled Payment Entry ${payload.doc.name}`);
  }
}
