import { BadRequestException, Injectable, Logger } from "@nestjs/common";
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
const COGS = "Cost of Goods Sold";

interface Line {
  account: string;
  debit: number;
  credit: number;
  against: string;
  cost_center?: string | null;
  project?: string | null;
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
        project: l.project ?? null,
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
    await this.setDoc("Sales Invoice", name, fields);
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

  /**
   * Move an invoice's outstanding by `sign * alloc` (sign −1 on payment, +1 on
   * cancel) and set Paid/Unpaid, for either a Sales or Purchase Invoice.
   */
  private async reconcileInvoice(
    refDoctype: string,
    name: string,
    alloc: number,
    sign: -1 | 1,
  ): Promise<void> {
    if (refDoctype !== "Sales Invoice" && refDoctype !== "Purchase Invoice") return;
    if (!this.registry.has(refDoctype)) return;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("outstanding_amount")} AS o FROM ${quoteIdent(tableNameFor(refDoctype))}
         WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    const outstanding = sign < 0
      ? Math.max(0, Number(row?.o ?? 0) - alloc)
      : Number(row?.o ?? 0) + alloc;
    await this.setDoc(refDoctype, name, {
      outstanding_amount: outstanding,
      status: outstanding <= 0.0001 ? "Paid" : "Unpaid",
    });
  }

  @OnEvent("doc.on_submit:Sales Invoice")
  async onInvoiceSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const conv = Number(doc.conversion_rate ?? 1) || 1;
    const net = Number(doc.total ?? 0);
    const grand = Number(doc.grand_total ?? net);
    const against = String(doc.customer ?? "");
    const cc = (doc.cost_center as string) || null;
    const proj = (doc.project as string) || null;
    const isReturn = Boolean(doc.is_return);
    const ctx = systemContext(payload.user);

    // A credit note (is_return) mirrors the invoice: debit Sales/tax and credit
    // Debtors, using absolute amounts (its own totals are negative). Its
    // outstanding is negative — a receivable the business owes back.
    const lines: Line[] = [
      { account: DEBTORS, debit: isReturn ? 0 : grand * conv, credit: isReturn ? -grand * conv : 0, against, cost_center: cc },
      { account: SALES, debit: isReturn ? -net * conv : 0, credit: isReturn ? 0 : net * conv, against, cost_center: cc },
    ];
    for (const t of (doc.taxes as Array<Record<string, unknown>>) ?? []) {
      const amt = Number(t.tax_amount ?? 0);
      if (!amt) continue;
      const acct = (t.account_head as string) || SALES;
      lines.push({ account: acct, debit: isReturn ? amt * conv : 0, credit: isReturn ? 0 : amt * conv, against, cost_center: cc });
    }
    // Stamp the accounting dimension (project) onto every GL line.
    for (const l of lines) l.project = proj;
    try {
      await this.postLines(ctx, "Sales Invoice", String(doc.name), doc.posting_date, lines);
      await this.setInvoice(String(doc.name), {
        base_grand_total: grand * conv,
        outstanding_amount: grand,
        status: isReturn ? "Return" : "Unpaid",
      });
      this.logger.log(
        `Posted GL for ${isReturn ? "Credit Note" : "Sales Invoice"} ${doc.name} (base ${grand * conv})`,
      );
    } catch (err) {
      this.logger.error(`Failed GL for ${doc.name}: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Sales Invoice")
  async onInvoiceCancel(payload: DocEventPayload): Promise<void> {
    await this.reverseGl("Sales Invoice", payload.doc.name);
    await this.setInvoice(String(payload.doc.name), { status: "Cancelled", outstanding_amount: 0 });
  }

  @OnEvent("doc.on_submit:Purchase Invoice")
  async onPurchaseInvoiceSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const conv = Number(doc.conversion_rate ?? 1) || 1;
    const net = Number(doc.total ?? 0);
    const grand = Number(doc.grand_total ?? net);
    const against = String(doc.supplier ?? "");
    const cc = (doc.cost_center as string) || null;
    const proj = (doc.project as string) || null;
    const isReturn = Boolean(doc.is_return);
    const creditTo = String(doc.credit_to || CREDITORS);
    const expense = String(doc.expense_account || COGS);
    const ctx = systemContext(payload.user);

    // Mirror of a Sales Invoice: Dr expense/tax (what we bought), Cr Creditors
    // (what we owe). A debit note (is_return) reverses both, with a negative
    // outstanding — a payable the supplier owes back.
    const lines: Line[] = [
      { account: creditTo, debit: isReturn ? -grand * conv : 0, credit: isReturn ? 0 : grand * conv, against, cost_center: cc },
      { account: expense, debit: isReturn ? 0 : net * conv, credit: isReturn ? -net * conv : 0, against, cost_center: cc },
    ];
    for (const t of (doc.taxes as Array<Record<string, unknown>>) ?? []) {
      const amt = Number(t.tax_amount ?? 0);
      if (!amt) continue;
      const acct = (t.account_head as string) || expense;
      lines.push({ account: acct, debit: isReturn ? 0 : amt * conv, credit: isReturn ? -amt * conv : 0, against, cost_center: cc });
    }
    // Stamp the accounting dimension (project) onto every GL line.
    for (const l of lines) l.project = proj;
    try {
      await this.postLines(ctx, "Purchase Invoice", String(doc.name), doc.posting_date, lines);
      await this.setDoc("Purchase Invoice", String(doc.name), {
        base_grand_total: grand * conv,
        outstanding_amount: grand,
        status: isReturn ? "Return" : "Unpaid",
      });
      this.logger.log(
        `Posted GL for ${isReturn ? "Debit Note" : "Purchase Invoice"} ${doc.name} (base ${grand * conv})`,
      );
    } catch (err) {
      this.logger.error(`Failed GL for ${doc.name}: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Purchase Invoice")
  async onPurchaseInvoiceCancel(payload: DocEventPayload): Promise<void> {
    await this.reverseGl("Purchase Invoice", payload.doc.name);
    await this.setDoc("Purchase Invoice", String(payload.doc.name), {
      status: "Cancelled",
      outstanding_amount: 0,
    });
  }

  /** Resolve the cash/bank account for a Payment Entry from its Mode of Payment. */
  private async modeAccount(mode: unknown): Promise<{ account: string; type: string } | undefined> {
    if (!mode || !this.registry.has("Mode of Payment")) return undefined;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("default_account")} AS account, ${quoteIdent("type")} AS type
         FROM ${quoteIdent(tableNameFor("Mode of Payment"))} WHERE ${quoteIdent("name")} = $1`,
        [String(mode)],
      )
    )[0];
    return row ? { account: String(row.account ?? ""), type: String(row.type ?? "Cash") } : undefined;
  }

  /**
   * A non-cash Mode of Payment (Bank / Cheque) requires a reference number so
   * the cheque/transfer can be traced. suppressErrors:false aborts the submit.
   */
  @OnEvent("doc.before_submit:Payment Entry", { suppressErrors: false })
  async gatePaymentReference(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const mode = await this.modeAccount(doc.mode_of_payment);
    if (mode && mode.type !== "Cash" && !String(doc.reference_no ?? "").trim()) {
      throw new BadRequestException(
        `Payment Entry ${doc.name}: a ${mode.type} payment (${doc.mode_of_payment}) requires a reference number`,
      );
    }
  }

  @OnEvent("doc.on_submit:Payment Entry")
  async onPaymentSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const conv = Number(doc.conversion_rate ?? 1) || 1;
    const paid = Number(doc.paid_amount ?? 0);
    const base = paid * conv;
    const receive = String(doc.payment_type ?? "Receive") === "Receive";
    // The cash side follows the Mode of Payment's account (Bank vs Cash); the
    // other side is the party control account. Fall back to Cash if unset.
    const cashAccount = (await this.modeAccount(doc.mode_of_payment))?.account || CASH;
    const [debit, credit] = receive ? [cashAccount, DEBTORS] : [CREDITORS, cashAccount];
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
      // Reconcile against referenced invoices (Sales for Receive, Purchase for Pay).
      for (const r of (doc.references as Array<Record<string, unknown>>) ?? []) {
        if (!r.reference_name) continue;
        await this.reconcileInvoice(
          String(r.reference_doctype),
          String(r.reference_name),
          Number(r.allocated_amount ?? 0),
          -1,
        );
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
      if (!r.reference_name) continue;
      await this.reconcileInvoice(
        String(r.reference_doctype),
        String(r.reference_name),
        Number(r.allocated_amount ?? 0),
        1,
      );
    }
  }

  /**
   * Period close: zero out income/expense account balances and move net profit
   * into the equity (Retained Earnings) account with a balanced GL entry.
   */
  @OnEvent("doc.on_submit:Period Closing Voucher")
  async onPeriodClose(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const ctx = systemContext(payload.user);
    const closingAccount = String(doc.closing_account ?? "Retained Earnings");

    const balances: Array<{ account: string; type: string; bal: number }> =
      await this.dataSource.query(
        `SELECT gl."account" AS account, a."account_type" AS type,
                (sum(gl."credit") - sum(gl."debit")) AS bal
         FROM ${quoteIdent(tableNameFor("GL Entry"))} gl
         JOIN ${quoteIdent(tableNameFor("Account"))} a ON a."name" = gl."account"
         WHERE a."account_type" IN ('Income','Expense')
         GROUP BY gl."account", a."account_type"
         HAVING (sum(gl."credit") - sum(gl."debit")) <> 0`,
      );

    const lines: Line[] = [];
    let netProfit = 0;
    for (const b of balances) {
      const bal = Number(b.bal); // credit-positive for income, debit-negative for expense
      netProfit += bal; // income adds, expense (negative bal) subtracts
      // Reverse the account's balance to zero it.
      if (bal > 0) lines.push({ account: b.account, debit: bal, credit: 0, against: closingAccount });
      else lines.push({ account: b.account, debit: 0, credit: -bal, against: closingAccount });
    }
    // Book the net into equity (credit for profit, debit for loss).
    if (netProfit >= 0) lines.push({ account: closingAccount, debit: 0, credit: netProfit, against: "Period Close" });
    else lines.push({ account: closingAccount, debit: -netProfit, credit: 0, against: "Period Close" });

    try {
      await this.postLines(ctx, "Period Closing Voucher", String(doc.name), doc.posting_date, lines);
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Period Closing Voucher"))} SET ${quoteIdent("net_profit")} = $1
         WHERE ${quoteIdent("name")} = $2`,
        [netProfit, doc.name],
      );
      this.logger.log(`Period close ${doc.name}: net profit ${netProfit} -> ${closingAccount}`);
    } catch (err) {
      this.logger.error(`Period close ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Period Closing Voucher")
  async onPeriodCloseCancel(payload: DocEventPayload): Promise<void> {
    await this.reverseGl("Period Closing Voucher", payload.doc.name);
  }
}
