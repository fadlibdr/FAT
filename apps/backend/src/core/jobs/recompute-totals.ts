import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { FieldType } from "@fat/shared";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { DocumentService } from "../doctype/document.service";
import { tableNameFor, quoteIdent } from "../doctype/schema-sync.service";
import type { DocEventPayload } from "../doctype/hooks.service";
import { JobService } from "./job.service";

const JOB = "recompute_totals";

/**
 * Registers (and triggers) the `recompute_totals` background job: for any
 * document with an `items` child table and a `total` field, it computes each
 * line's amount (qty * rate), the net total, taxes (rate % of net, or explicit
 * tax_amount), and writes total / total_taxes_and_charges / grand_total —
 * updating the child rows in place. Demonstrates the JobService abstraction.
 */
@Injectable()
export class RecomputeTotalsJob implements OnModuleInit {
  private readonly logger = new Logger(RecomputeTotalsJob.name);

  constructor(
    private readonly jobs: JobService,
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onModuleInit(): void {
    this.jobs.register(JOB, (payload) => this.handle(payload));
  }

  private hasTotals(doctype: string): boolean {
    const dt = this.registry.get(doctype);
    if (!dt) return false;
    const hasItems = dt.fields.some(
      (f) => f.fieldname === "items" && (f.fieldtype as FieldType) === FieldType.Table,
    );
    const hasTotal = dt.fields.some((f) => f.fieldname === "total");
    return hasItems && hasTotal;
  }

  @OnEvent("doc.after_insert")
  onInsert(payload: DocEventPayload): void {
    this.maybeEnqueue(payload);
  }

  @OnEvent("doc.after_update")
  onUpdate(payload: DocEventPayload): void {
    this.maybeEnqueue(payload);
  }

  private maybeEnqueue(payload: DocEventPayload): void {
    if (!this.hasTotals(payload.doctype)) return;
    void this.jobs.enqueue(JOB, { doctype: payload.doctype, name: payload.doc.name });
  }

  private childTableOf(doctype: string, fieldname: string): string | undefined {
    const dt = this.registry.get(doctype);
    const field = dt?.fields.find(
      (f) => f.fieldname === fieldname && (f.fieldtype as FieldType) === FieldType.Table,
    );
    return field?.options;
  }

  private async setChildValue(
    childDoctype: string,
    rowName: string,
    col: string,
    value: number,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(childDoctype))} SET ${quoteIdent(col)} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [value, rowName],
    );
  }

  private async handle(payload: Record<string, unknown>): Promise<void> {
    const doctype = String(payload.doctype);
    const name = String(payload.name);
    const dt = this.registry.get(doctype);
    if (!dt) return;

    const doc = await this.documents.get(dt, name);

    // 1) Line amounts -> net total.
    const itemChild = this.childTableOf(doctype, "items");
    const items = (doc.items as Array<Record<string, unknown>>) ?? [];
    let net = 0;
    for (const row of items) {
      const qty = Number(row.qty ?? 0);
      const rate = Number(row.rate ?? 0);
      const amount = qty && rate ? qty * rate : Number(row.amount ?? 0);
      if (!Number.isNaN(amount)) net += amount;
      if (itemChild && row.name && qty && rate) {
        await this.setChildValue(itemChild, String(row.name), "amount", amount);
      }
    }

    // 2) Taxes -> total taxes (rate % of net, else explicit tax_amount).
    const taxChild = this.childTableOf(doctype, "taxes");
    const taxes = (doc.taxes as Array<Record<string, unknown>>) ?? [];
    let totalTaxes = 0;
    for (const row of taxes) {
      const rate = Number(row.rate ?? 0);
      const amount = rate ? (net * rate) / 100 : Number(row.tax_amount ?? 0);
      if (!Number.isNaN(amount)) totalTaxes += amount;
      if (taxChild && row.name && rate) {
        await this.setChildValue(taxChild, String(row.name), "tax_amount", amount);
      }
    }

    // 3) Parent totals.
    const has = (fn: string) => dt.fields.some((f) => f.fieldname === fn);
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: number) => {
      params.push(val);
      sets.push(`${quoteIdent(col)} = $${params.length}`);
    };
    if (has("total")) push("total", net);
    if (has("total_taxes_and_charges")) push("total_taxes_and_charges", totalTaxes);
    if (has("grand_total")) push("grand_total", net + totalTaxes);
    if (sets.length === 0) return;
    params.push(name);
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${sets.join(", ")}
       WHERE ${quoteIdent("name")} = $${params.length}`,
      params,
    );
    this.logger.log(
      `Recomputed ${doctype} ${name}: net=${net} taxes=${totalTaxes} grand=${net + totalTaxes}`,
    );
  }
}
