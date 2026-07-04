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
 * document that has an `items` child table and a `total` field, it sums the
 * line amounts (falling back to qty * rate) and writes `total` / `grand_total`.
 * Demonstrates the JobService abstraction end-to-end.
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

  private async handle(payload: Record<string, unknown>): Promise<void> {
    const doctype = String(payload.doctype);
    const name = String(payload.name);
    const dt = this.registry.get(doctype);
    if (!dt) return;

    const doc = await this.documents.get(dt, name);
    const items = (doc.items as Array<Record<string, unknown>>) ?? [];
    let total = 0;
    for (const row of items) {
      const amount =
        row.amount !== undefined && row.amount !== null
          ? Number(row.amount)
          : Number(row.qty ?? 0) * Number(row.rate ?? 0);
      if (!Number.isNaN(amount)) total += amount;
    }

    const hasGrand = dt.fields.some((f) => f.fieldname === "grand_total");
    const sets = [`${quoteIdent("total")} = $1`];
    const params: unknown[] = [total];
    if (hasGrand) {
      sets.push(`${quoteIdent("grand_total")} = $2`);
      params.push(total);
    }
    params.push(name);
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${sets.join(", ")}
       WHERE ${quoteIdent("name")} = $${params.length}`,
      params,
    );
    this.logger.log(`Recomputed total for ${doctype} ${name} = ${total}`);
  }
}
