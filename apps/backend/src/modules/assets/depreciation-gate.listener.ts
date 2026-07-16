import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Rounding tolerance for currency comparisons. */
const TOL = 0.01;

/**
 * Depreciation guard. Straight-line depreciation must never take an asset below
 * its salvage value, and a Depreciation Entry's stated amount should equal what
 * actually posts. Two pure event-bus behaviours, no cross-module imports:
 *
 *  1. before_save fills a blank amount with the asset's straight-line monthly
 *     charge, clamped to the remaining depreciable value.
 *  2. before_submit rejects a non-positive amount, a fully-depreciated asset, and
 *     any amount that would depreciate past the salvage floor.
 */
@Injectable()
export class DepreciationGateListener {
  private readonly logger = new Logger(DepreciationGateListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async assetOf(name: string): Promise<{ gross: number; salvage: number; life: number; accumulated: number } | null> {
    if (!name || !this.registry.has("Asset")) return null;
    const a = (
      await this.dataSource.query(
        `SELECT coalesce(${quoteIdent("gross_purchase_amount")}, 0) AS gross,
                coalesce(${quoteIdent("salvage_value")}, 0) AS salvage,
                coalesce(${quoteIdent("useful_life_years")}, 0) AS life,
                coalesce(${quoteIdent("accumulated_depreciation")}, 0) AS accumulated
         FROM ${quoteIdent(tableNameFor("Asset"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (!a) return null;
    return { gross: Number(a.gross), salvage: Number(a.salvage), life: Number(a.life) || 1, accumulated: Number(a.accumulated) };
  }

  @OnEvent("doc.before_save:Depreciation Entry")
  async fillAmount(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    if (Number(d.amount ?? 0) > 0 || !d.asset) return;
    const a = await this.assetOf(String(d.asset));
    if (!a) return;
    const remaining = Math.max(0, a.gross - a.salvage - a.accumulated);
    const monthly = (a.gross - a.salvage) / a.life / 12;
    const amount = Math.min(Math.round(monthly * 100) / 100, Math.round(remaining * 100) / 100);
    if (amount > 0) {
      d.amount = amount;
      this.logger.log(`Depreciation Entry for ${d.asset}: auto-filled amount ${amount}`);
    }
  }

  // suppressErrors:false so an over-depreciation aborts the submit.
  @OnEvent("doc.before_submit:Depreciation Entry", { suppressErrors: false })
  async gate(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const amount = Number(doc.amount ?? 0);
    const a = await this.assetOf(String(doc.asset ?? ""));
    if (a) {
      const remaining = Math.round((a.gross - a.salvage - a.accumulated) * 100) / 100;
      if (remaining <= TOL) {
        throw new BadRequestException(`Asset ${doc.asset} is already fully depreciated`);
      }
      if (amount > remaining + TOL) {
        throw new BadRequestException(
          `Depreciation Entry ${doc.name}: amount ${amount} exceeds the remaining depreciable value ${remaining} (salvage floor ${a.salvage})`,
        );
      }
    }
    if (amount <= 0) {
      throw new BadRequestException(`Depreciation Entry ${doc.name}: amount must be positive`);
    }
  }
}
