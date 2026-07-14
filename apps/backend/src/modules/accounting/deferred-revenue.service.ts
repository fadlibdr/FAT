import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Releases deferred revenue to income as each monthly installment falls due.
 * For every submitted schedule with unrecognized rows on/before `asOf`, posts
 * Dr Deferred Revenue / Cr Income for the row amount, flags the row recognized,
 * and bumps the schedule's recognized total (completing it when fully released).
 */
@Injectable()
export class DeferredRevenueService {
  private readonly logger = new Logger(DeferredRevenueService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async run(asOf?: string, ctx?: UserContext): Promise<{ recognized: number; entries: number }> {
    const glDt = this.registry.get("GL Entry");
    if (!glDt || !this.registry.has("Deferred Revenue Schedule")) return { recognized: 0, entries: 0 };
    const context = ctx ?? systemContext();
    const cutoff = asOf ?? new Date().toISOString().slice(0, 10);

    const schedules: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("posting_date")} AS posting_date,
              ${quoteIdent("customer")} AS customer, ${quoteIdent("deferred_account")} AS deferred_account,
              ${quoteIdent("income_account")} AS income_account,
              ${quoteIdent("recognized_amount")} AS recognized_amount, ${quoteIdent("total_amount")} AS total_amount
       FROM ${quoteIdent(tableNameFor("Deferred Revenue Schedule"))}
       WHERE ${quoteIdent("docstatus")} = 1 AND ${quoteIdent("status")} = 'Active'`,
    );

    let totalRecognized = 0;
    let entries = 0;
    for (const s of schedules) {
      const rows: Array<Record<string, unknown>> = await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("amount")} AS amount,
                ${quoteIdent("recognition_date")} AS recognition_date
         FROM ${quoteIdent(tableNameFor("Deferred Revenue Entry"))}
         WHERE ${quoteIdent("parent")} = $1 AND coalesce(${quoteIdent("recognized")}, 0) = 0
           AND ${quoteIdent("recognition_date")} <= $2
         ORDER BY ${quoteIdent("recognition_date")}`,
        [String(s.name), cutoff],
      );
      if (rows.length === 0) continue;
      const deferred = String(s.deferred_account || "Deferred Revenue");
      const income = String(s.income_account || "Sales");
      const against = String(s.customer ?? "");
      let recognized = Number(s.recognized_amount ?? 0);
      for (const r of rows) {
        const amount = Number(r.amount ?? 0);
        if (amount <= 0) continue;
        await this.documents.create(glDt, context, {
          posting_date: r.recognition_date ?? s.posting_date ?? null,
          voucher_type: "Deferred Revenue Schedule", voucher_no: String(s.name),
          account: deferred, debit: amount, credit: 0, against,
        });
        await this.documents.create(glDt, context, {
          posting_date: r.recognition_date ?? s.posting_date ?? null,
          voucher_type: "Deferred Revenue Schedule", voucher_no: String(s.name),
          account: income, debit: 0, credit: amount, against,
        });
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Deferred Revenue Entry"))} SET ${quoteIdent("recognized")} = 1
           WHERE ${quoteIdent("name")} = $1`,
          [String(r.name)],
        );
        recognized += amount;
        totalRecognized += amount;
        entries += 1;
      }
      const done = recognized >= Number(s.total_amount ?? 0) - 0.0001;
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Deferred Revenue Schedule"))}
         SET ${quoteIdent("recognized_amount")} = $1, ${quoteIdent("status")} = $2
         WHERE ${quoteIdent("name")} = $3`,
        [recognized, done ? "Completed" : "Active", String(s.name)],
      );
    }
    this.logger.log(`Deferred revenue run (<= ${cutoff}): recognized ${totalRecognized} across ${entries} entries`);
    return { recognized: totalRecognized, entries };
  }
}
