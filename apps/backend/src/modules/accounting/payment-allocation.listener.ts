import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const EPS = 0.0001;

/**
 * Payment allocation integrity. A before_submit gate over a Payment Entry's
 * reference rows, complementing the reference-number gate in GlPostingListener:
 *
 *  - every allocation must be positive;
 *  - the total allocated across references cannot exceed the amount paid (you
 *    can't settle more than you moved — any excess is an unallocated advance);
 *  - no single allocation may exceed the referenced invoice's own outstanding.
 *
 * Reads sibling tables directly; no cross-module service imports.
 */
@Injectable()
export class PaymentAllocationListener {
  private readonly logger = new Logger(PaymentAllocationListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_submit:Payment Entry", { suppressErrors: false })
  async gateAllocation(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const refs = (doc.references as Array<Record<string, unknown>>) ?? [];
    if (refs.length === 0) return; // a pure on-account payment allocates nothing

    const paid = Number(doc.paid_amount ?? 0);
    let total = 0;
    for (const r of refs) {
      const alloc = Number(r.allocated_amount ?? 0);
      if (alloc <= 0) {
        throw new BadRequestException(
          `Payment Entry ${doc.name}: allocation to ${r.reference_name ?? "a reference"} must be positive`,
        );
      }
      total += alloc;
      const outstanding = await this.outstandingOf(String(r.reference_doctype ?? ""), String(r.reference_name ?? ""));
      if (outstanding !== undefined && alloc > outstanding + EPS) {
        throw new BadRequestException(
          `Payment Entry ${doc.name}: allocation ${alloc} to ${r.reference_name} exceeds its outstanding ${outstanding}`,
        );
      }
    }
    if (total > paid + EPS) {
      throw new BadRequestException(
        `Payment Entry ${doc.name}: allocated ${this.round(total)} exceeds paid amount ${this.round(paid)}`,
      );
    }
    this.logger.log(`Payment Entry ${doc.name} allocation ok (${this.round(total)} of ${this.round(paid)})`);
  }

  /** Current outstanding on a referenced Sales/Purchase Invoice, else undefined. */
  private async outstandingOf(refDoctype: string, name: string): Promise<number | undefined> {
    if ((refDoctype !== "Sales Invoice" && refDoctype !== "Purchase Invoice") || !name) return undefined;
    if (!this.registry.has(refDoctype)) return undefined;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("outstanding_amount")} AS o FROM ${quoteIdent(tableNameFor(refDoctype))}
         WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (row?.o === null || row?.o === undefined) return undefined;
    return Math.abs(Number(row.o));
  }

  private round(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }
}
