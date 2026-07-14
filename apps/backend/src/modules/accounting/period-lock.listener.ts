import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** ISO YYYY-MM-DD for a date value (Date fields deserialize as Date objects). */
function isoDate(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Accounting period lock. A voucher may not be posted into a closed Accounting
 * Period: before any of the main posting documents is submitted, its posting_date
 * is checked against the Accounting Period table, and a submit into a closed period
 * is rejected. Pure event-bus listener — no cross-module service imports.
 */
@Injectable()
export class PeriodLockListener {
  private readonly logger = new Logger(PeriodLockListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async assertOpen(doctype: string, doc: Record<string, unknown>): Promise<void> {
    if (!this.registry.has("Accounting Period")) return;
    const posting = isoDate(doc.posting_date);
    if (!posting) return;
    const period = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("period_name")} AS name FROM ${quoteIdent(tableNameFor("Accounting Period"))}
         WHERE coalesce(${quoteIdent("is_closed")}, 0) = 1
           AND ${quoteIdent("from_date")} <= $1 AND ${quoteIdent("to_date")} >= $1
         LIMIT 1`,
        [posting],
      )
    )[0];
    if (period) {
      throw new BadRequestException(
        `${doctype} ${doc.name}: posting date ${posting} falls in closed accounting period "${period.name}"`,
      );
    }
  }

  // suppressErrors:false so a closed-period posting is rejected.
  @OnEvent("doc.before_submit:Journal Entry", { suppressErrors: false })
  async gateJournal(payload: DocEventPayload): Promise<void> {
    await this.assertOpen("Journal Entry", payload.doc);
  }

  @OnEvent("doc.before_submit:Sales Invoice", { suppressErrors: false })
  async gateSales(payload: DocEventPayload): Promise<void> {
    await this.assertOpen("Sales Invoice", payload.doc);
  }

  @OnEvent("doc.before_submit:Purchase Invoice", { suppressErrors: false })
  async gatePurchase(payload: DocEventPayload): Promise<void> {
    await this.assertOpen("Purchase Invoice", payload.doc);
  }
}
