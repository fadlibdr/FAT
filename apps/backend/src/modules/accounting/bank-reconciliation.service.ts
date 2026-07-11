import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

export interface Match {
  transaction: string;
  payment_entry: string;
  amount: number;
}

/**
 * Auto-matches unreconciled Bank Transactions to submitted Payment Entries by
 * amount and direction (a deposit ↔ a Receive payment, a withdrawal ↔ a Pay
 * payment), preferring an equal reference_no when both carry one. Each Payment
 * Entry is used once. Matched transactions are marked Reconciled and linked.
 * Reads sibling tables by SQL — no cross-module service imports.
 */
@Injectable()
export class BankReconciliationService {
  private readonly logger = new Logger(BankReconciliationService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async autoReconcile(bankAccount?: string): Promise<Match[]> {
    if (!this.registry.has("Bank Transaction") || !this.registry.has("Payment Entry")) return [];

    const params: unknown[] = [];
    // Field defaults are applied by the UI, not the engine, so a transaction
    // created via the API may have a NULL status — treat that as unreconciled.
    let where = `(${quoteIdent("status")} IS NULL OR ${quoteIdent("status")} = 'Unreconciled')`;
    if (bankAccount) {
      params.push(bankAccount);
      where += ` AND ${quoteIdent("bank_account")} = $${params.length}`;
    }
    const txns = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("deposit")} AS deposit,
              ${quoteIdent("withdrawal")} AS withdrawal, ${quoteIdent("reference_no")} AS reference_no
       FROM ${quoteIdent(tableNameFor("Bank Transaction"))}
       WHERE ${where} ORDER BY ${quoteIdent("date")}, ${quoteIdent("name")}`,
      params,
    );

    // Payment Entries already linked to a reconciled transaction are off-limits.
    const usedRows = await this.dataSource.query(
      `SELECT ${quoteIdent("payment_entry")} AS pe FROM ${quoteIdent(tableNameFor("Bank Transaction"))}
       WHERE ${quoteIdent("payment_entry")} IS NOT NULL AND ${quoteIdent("payment_entry")} <> ''`,
    );
    const used = new Set<string>(usedRows.map((r: { pe: string }) => String(r.pe)));

    const matches: Match[] = [];
    for (const t of txns) {
      const deposit = Number(t.deposit ?? 0);
      const withdrawal = Number(t.withdrawal ?? 0);
      const amount = deposit > 0 ? deposit : withdrawal;
      if (amount <= 0) continue;
      const paymentType = deposit > 0 ? "Receive" : "Pay";
      const pe = await this.findPayment(amount, paymentType, t.reference_no as string | null, used);
      if (!pe) continue;
      used.add(pe);
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Bank Transaction"))}
         SET ${quoteIdent("status")} = 'Reconciled', ${quoteIdent("payment_entry")} = $1,
             ${quoteIdent("modified")} = $2 WHERE ${quoteIdent("name")} = $3`,
        [pe, new Date().toISOString(), String(t.name)],
      );
      matches.push({ transaction: String(t.name), payment_entry: pe, amount });
      this.logger.log(`Reconciled ${t.name} <-> ${pe} (${amount})`);
    }
    return matches;
  }

  /** Find one submitted, unused Payment Entry of the given amount/type, preferring reference_no. */
  private async findPayment(
    amount: number,
    paymentType: string,
    referenceNo: string | null,
    used: Set<string>,
  ): Promise<string | null> {
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("reference_no")} AS reference_no
       FROM ${quoteIdent(tableNameFor("Payment Entry"))}
       WHERE ${quoteIdent("payment_type")} = $1 AND ${quoteIdent("paid_amount")} = $2
         AND ${quoteIdent("docstatus")} = 1
       ORDER BY ${quoteIdent("posting_date")}, ${quoteIdent("name")}`,
      [paymentType, amount],
    );
    const available = rows.filter((r: { name: string }) => !used.has(String(r.name)));
    if (available.length === 0) return null;
    if (referenceNo) {
      const byRef = available.find(
        (r: { reference_no: string | null }) => r.reference_no && String(r.reference_no) === referenceNo,
      );
      if (byRef) return String(byRef.name);
    }
    return String(available[0].name);
  }
}
