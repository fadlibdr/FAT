import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

const EXPENSE = "Depreciation Expense";
const ACCUMULATED = "Accumulated Depreciation";

/**
 * Asset lifecycle + straight-line depreciation. A submitted Depreciation Entry
 * books Dr Depreciation Expense / Cr Accumulated Depreciation for the period and
 * writes the charge back onto the Asset (accumulated depreciation, current value,
 * status). Cancel reverses the GL and unwinds the asset. Pure event-bus listener.
 */
@Injectable()
export class AssetsListener {
  private readonly logger = new Logger(AssetsListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async setAsset(name: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Asset"))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  @OnEvent("doc.on_submit:Asset")
  async onAssetSubmit(payload: DocEventPayload): Promise<void> {
    const a = payload.doc;
    await this.setAsset(String(a.name), {
      status: "Submitted",
      value_after_depreciation: Number(a.gross_purchase_amount ?? 0),
      accumulated_depreciation: 0,
    });
  }

  @OnEvent("doc.on_cancel:Asset")
  async onAssetCancel(payload: DocEventPayload): Promise<void> {
    await this.setAsset(String(payload.doc.name), { status: "Cancelled" });
  }

  @OnEvent("doc.on_submit:Depreciation Entry")
  async onDepreciationSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const glDt = this.registry.get("GL Entry");
    const assetDt = this.registry.get("Asset");
    if (!glDt || !assetDt) return;
    const ctx = systemContext(payload.user);

    try {
      const asset = await this.documents.get(assetDt, String(doc.asset));
      const gross = Number(asset.gross_purchase_amount ?? 0);
      const salvage = Number(asset.salvage_value ?? 0);
      const life = Number(asset.useful_life_years ?? 0) || 1;
      const already = Number(asset.accumulated_depreciation ?? 0);
      const depreciable = Math.max(0, gross - salvage - already);

      // Auto-compute the straight-line annual charge if none was supplied, and
      // never depreciate below the salvage value.
      let amount = Number(doc.amount ?? 0);
      if (!amount) amount = (gross - salvage) / life;
      amount = Math.min(amount, depreciable);
      if (amount <= 0) {
        this.logger.warn(`Depreciation Entry ${doc.name}: asset ${doc.asset} fully depreciated`);
        return;
      }

      const expense = String(doc.expense_account ?? EXPENSE);
      const accumulated = String(doc.accumulated_account ?? ACCUMULATED);
      for (const line of [
        { account: expense, debit: amount, credit: 0 },
        { account: accumulated, debit: 0, credit: amount },
      ]) {
        await this.documents.create(glDt, ctx, {
          posting_date: doc.posting_date ?? null,
          voucher_type: "Depreciation Entry",
          voucher_no: doc.name,
          account: line.account,
          debit: line.debit,
          credit: line.credit,
          against: String(doc.asset ?? ""),
        });
      }

      const newAccum = already + amount;
      const newValue = gross - newAccum;
      await this.setAsset(String(doc.asset), {
        accumulated_depreciation: newAccum,
        value_after_depreciation: newValue,
        status: newValue <= salvage + 0.0001 ? "Fully Depreciated" : "Partially Depreciated",
      });
      // Persist the actual amount charged (in case it was auto-computed/capped).
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Depreciation Entry"))} SET ${quoteIdent("amount")} = $1
         WHERE ${quoteIdent("name")} = $2`,
        [amount, doc.name],
      );
      this.logger.log(`Depreciation ${doc.name}: ${amount} on ${doc.asset} (accum ${newAccum})`);
    } catch (err) {
      this.logger.error(`Depreciation Entry ${doc.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Depreciation Entry")
  async onDepreciationCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const assetDt = this.registry.get("Asset");
    if (this.registry.has("GL Entry")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
         WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
        ["Depreciation Entry", doc.name],
      );
    }
    if (!assetDt) return;
    try {
      const asset = await this.documents.get(assetDt, String(doc.asset));
      const gross = Number(asset.gross_purchase_amount ?? 0);
      const salvage = Number(asset.salvage_value ?? 0);
      const accum = Math.max(0, Number(asset.accumulated_depreciation ?? 0) - Number(doc.amount ?? 0));
      await this.setAsset(String(doc.asset), {
        accumulated_depreciation: accum,
        value_after_depreciation: gross - accum,
        status: accum <= 0.0001 ? "Submitted" : "Partially Depreciated",
      });
    } catch (err) {
      this.logger.error(`Reversing Depreciation Entry ${doc.name} failed: ${(err as Error).message}`);
    }
  }
}
