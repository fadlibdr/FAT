import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Periodic depreciation run. For every submitted asset still carrying value above
 * its salvage and not yet depreciated for the cutoff period, posts one month of
 * straight-line depreciation by creating and submitting a Depreciation Entry (the
 * AssetsListener does the GL posting and accumulated-depreciation rollup) and
 * stamps `last_depreciation_date` so a repeat run for the same cutoff is a no-op.
 */
@Injectable()
export class AssetDepreciationService {
  private readonly logger = new Logger(AssetDepreciationService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async run(asOf?: string, ctx?: UserContext): Promise<{ assets: number; depreciated: number }> {
    const entryDt = this.registry.get("Depreciation Entry");
    if (!entryDt || !this.registry.has("Asset")) return { assets: 0, depreciated: 0 };
    const context = ctx ?? systemContext();
    const cutoff = asOf ?? new Date().toISOString().slice(0, 10);

    const assets: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("gross_purchase_amount")} AS gross,
              coalesce(${quoteIdent("salvage_value")}, 0) AS salvage,
              ${quoteIdent("useful_life_years")} AS life,
              coalesce(${quoteIdent("accumulated_depreciation")}, 0) AS accumulated
       FROM ${quoteIdent(tableNameFor("Asset"))}
       WHERE ${quoteIdent("docstatus")} = 1
         AND ${quoteIdent("status")} NOT IN ('Fully Depreciated', 'Scrapped', 'Sold', 'Cancelled')
         AND (${quoteIdent("last_depreciation_date")} IS NULL OR ${quoteIdent("last_depreciation_date")} < $1)`,
      [cutoff],
    );

    let count = 0;
    let total = 0;
    for (const a of assets) {
      const gross = Number(a.gross ?? 0);
      const salvage = Number(a.salvage ?? 0);
      const life = Number(a.life ?? 0) || 1;
      const accumulated = Number(a.accumulated ?? 0);
      const remaining = round2(gross - salvage - accumulated);
      if (remaining <= 0) continue;
      const monthly = round2((gross - salvage) / life / 12);
      const amount = Math.min(monthly, remaining);
      if (amount <= 0) continue;
      try {
        const entry = await this.documents.create(entryDt, context, {
          asset: String(a.name),
          posting_date: cutoff,
          amount,
          expense_account: "Depreciation Expense",
          accumulated_account: "Accumulated Depreciation",
        });
        await this.documents.setDocStatus(entryDt, context, String(entry.name), 1);
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Asset"))} SET ${quoteIdent("last_depreciation_date")} = $1
           WHERE ${quoteIdent("name")} = $2`,
          [cutoff, String(a.name)],
        );
        total += amount;
        count += 1;
      } catch (err) {
        this.logger.error(`Depreciation run: asset ${a.name} failed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Depreciation run (<= ${cutoff}): ${count} asset(s), ${round2(total)} depreciated`);
    return { assets: count, depreciated: round2(total) };
  }
}
