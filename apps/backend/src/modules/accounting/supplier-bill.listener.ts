import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Accounts-payable control: a supplier's physical invoice number (`bill_no`)
 * must not be booked twice. Before a Purchase Invoice is submitted, if it
 * carries a bill number, any other submitted invoice for the same supplier with
 * the same number (trimmed, case-insensitive) blocks the submit — guarding
 * against paying the same supplier bill more than once. A return (debit note) is
 * exempt. Pure event-bus listener — reads via SQL, no cross-module imports.
 */
@Injectable()
export class SupplierBillListener {
  private readonly logger = new Logger(SupplierBillListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so a duplicate-bill error aborts the submit.
  @OnEvent("doc.before_submit:Purchase Invoice", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (Boolean(doc.is_return)) return; // a debit note is not a fresh bill
    const supplier = String(doc.supplier ?? "");
    const billNo = String(doc.bill_no ?? "").trim();
    if (!supplier || !billNo || !this.registry.has("Purchase Invoice")) return;

    const dup = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS n FROM ${quoteIdent(tableNameFor("Purchase Invoice"))}
         WHERE ${quoteIdent("supplier")} = $1 AND ${quoteIdent("docstatus")} = 1
           AND ${quoteIdent("name")} <> $2
           AND lower(btrim(${quoteIdent("bill_no")})) = lower($3)
         LIMIT 1`,
        [supplier, String(doc.name ?? ""), billNo],
      )
    )[0];
    if (dup) {
      throw new BadRequestException(
        `Supplier ${supplier} bill "${billNo}" is already booked on Purchase Invoice ${dup.n}`,
      );
    }
    this.logger.log(`Purchase Invoice ${doc.name}: bill "${billNo}" is unique for ${supplier}`);
  }
}
