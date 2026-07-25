import { BadRequestException, Injectable, Logger } from "@nestjs/common";
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
const FIXED_ASSETS = "Fixed Assets";
const REPAIRS = "Repairs Expense";
const CREDITORS = "Creditors";
const CASH = "Cash";
const DISPOSAL_GAIN_LOSS = "Gain/Loss on Asset Disposal";

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

  /**
   * Asset Movement: relocate an asset. On submit we stamp the movement's
   * from_location with the asset's current location, then set the asset to the
   * new location/custodian; cancel restores the previous location.
   */
  /** Post a set of balanced GL lines for a voucher. */
  private async postGl(
    ctx: ReturnType<typeof systemContext>,
    voucherType: string,
    voucherNo: string,
    postingDate: unknown,
    against: string,
    lines: Array<{ account: string; debit: number; credit: number }>,
  ): Promise<void> {
    const glDt = this.registry.get("GL Entry");
    if (!glDt) return;
    for (const l of lines) {
      if (!l.debit && !l.credit) continue;
      await this.documents.create(glDt, ctx, {
        posting_date: postingDate ?? null,
        voucher_type: voucherType,
        voucher_no: voucherNo,
        account: l.account,
        debit: l.debit,
        credit: l.credit,
        against,
      });
    }
  }

  private async reverseGl(voucherType: string, voucherNo: unknown): Promise<void> {
    if (!this.registry.has("GL Entry")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("GL Entry"))}
       WHERE ${quoteIdent("voucher_type")} = $1 AND ${quoteIdent("voucher_no")} = $2`,
      [voucherType, voucherNo],
    );
  }

  /** An asset's book value and accumulated depreciation, or null if it doesn't exist. */
  private async assetValue(name: string): Promise<{ value: number; accumulated: number; docstatus: number } | undefined> {
    if (!name || !this.registry.has("Asset")) return undefined;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(${quoteIdent("value_after_depreciation")}, 0) AS value,
                coalesce(${quoteIdent("accumulated_depreciation")}, 0) AS accumulated,
                ${quoteIdent("docstatus")} AS docstatus
         FROM ${quoteIdent(tableNameFor("Asset"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    return row ? { value: Number(row.value), accumulated: Number(row.accumulated), docstatus: Number(row.docstatus) } : undefined;
  }

  /**
   * Asset Value Adjustment: revalue an asset's book value. A write-down books
   * Dr Depreciation Expense / Cr Accumulated Depreciation for the reduction (a
   * write-up reverses that), then sets the asset to the new value and rolls the
   * reduction onto accumulated depreciation. A pre-submit gate keeps the target a
   * real, changed, non-negative value; cancel reverses the GL and the asset.
   */
  // suppressErrors:false so a bad target value aborts the submit.
  @OnEvent("doc.before_submit:Asset Value Adjustment", { suppressErrors: false })
  async gateAdjustment(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const newValue = Number(doc.new_value ?? 0);
    if (newValue < 0) throw new BadRequestException("New Book Value cannot be negative");
    const asset = await this.assetValue(String(doc.asset ?? ""));
    if (!asset) throw new BadRequestException(`Asset ${doc.asset} not found`);
    if (asset.docstatus !== 1) throw new BadRequestException(`Asset ${doc.asset} is not submitted`);
    if (Math.abs(newValue - asset.value) < 1e-6) {
      throw new BadRequestException(`New Book Value equals the current book value (${asset.value})`);
    }
  }

  @OnEvent("doc.on_submit:Asset Value Adjustment")
  async onAdjustmentSubmit(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const asset = await this.assetValue(String(doc.asset ?? ""));
    if (!asset) return;
    const ctx = systemContext(payload.user);
    const newValue = Number(doc.new_value ?? 0);
    const reduction = asset.value - newValue; // >0 write-down, <0 write-up
    const amount = Math.abs(reduction);
    const lines = reduction > 0
      ? [{ account: EXPENSE, debit: amount, credit: 0 }, { account: ACCUMULATED, debit: 0, credit: amount }]
      : [{ account: ACCUMULATED, debit: amount, credit: 0 }, { account: EXPENSE, debit: 0, credit: amount }];
    await this.postGl(ctx, "Asset Value Adjustment", String(doc.name), doc.adjustment_date, String(doc.asset ?? ""), lines);
    await this.setAsset(String(doc.asset), {
      value_after_depreciation: newValue,
      accumulated_depreciation: asset.accumulated + reduction,
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Asset Value Adjustment"))}
       SET ${quoteIdent("current_value")} = $1, ${quoteIdent("difference")} = $2 WHERE ${quoteIdent("name")} = $3`,
      [asset.value, newValue - asset.value, String(doc.name)],
    );
    this.logger.log(`Asset Value Adjustment ${doc.name}: ${doc.asset} ${asset.value} -> ${newValue}`);
  }

  @OnEvent("doc.on_cancel:Asset Value Adjustment")
  async onAdjustmentCancel(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    await this.reverseGl("Asset Value Adjustment", doc.name);
    const asset = await this.assetValue(String(doc.asset ?? ""));
    if (!asset) return;
    const prior = Number(doc.current_value ?? 0);
    const reduction = prior - Number(doc.new_value ?? 0);
    // Restore the pre-adjustment book value and unwind the accumulated reduction.
    await this.setAsset(String(doc.asset), {
      value_after_depreciation: prior,
      accumulated_depreciation: asset.accumulated - reduction,
    });
  }

  /**
   * Asset Repair: expense the cost (Dr Repairs / Cr payable) or capitalise it
   * (Dr the asset account / Cr payable and add the cost to the asset's gross &
   * current value). Cancel reverses both the GL and any capitalisation.
   */
  @OnEvent("doc.on_submit:Asset Repair")
  async onRepairSubmit(payload: DocEventPayload): Promise<void> {
    const rep = payload.doc;
    const assetDt = this.registry.get("Asset");
    if (!assetDt || !this.registry.has("GL Entry")) return;
    const ctx = systemContext(payload.user);
    const cost = Number(rep.repair_cost ?? 0);
    if (cost <= 0) return;
    const capitalize = Boolean(rep.capitalize);
    const debit = capitalize ? String(rep.asset_account || FIXED_ASSETS) : String(rep.repair_account || REPAIRS);
    const payable = String(rep.payable_account || CREDITORS);

    try {
      await this.postGl(ctx, "Asset Repair", String(rep.name), rep.repair_date, String(rep.asset ?? ""), [
        { account: debit, debit: cost, credit: 0 },
        { account: payable, debit: 0, credit: cost },
      ]);
      if (capitalize) {
        const asset = await this.documents.get(assetDt, String(rep.asset));
        await this.setAsset(String(rep.asset), {
          gross_purchase_amount: Number(asset.gross_purchase_amount ?? 0) + cost,
          value_after_depreciation: Number(asset.value_after_depreciation ?? 0) + cost,
        });
      }
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Asset Repair"))} SET ${quoteIdent("status")} = 'Completed'
         WHERE ${quoteIdent("name")} = $1`,
        [String(rep.name)],
      );
      this.logger.log(`Asset Repair ${rep.name}: ${cost} ${capitalize ? "capitalised" : "expensed"} on ${rep.asset}`);
    } catch (err) {
      this.logger.error(`Asset Repair ${rep.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Asset Repair")
  async onRepairCancel(payload: DocEventPayload): Promise<void> {
    const rep = payload.doc;
    await this.reverseGl("Asset Repair", rep.name);
    const assetDt = this.registry.get("Asset");
    if (assetDt && rep.capitalize && rep.asset) {
      const cost = Number(rep.repair_cost ?? 0);
      const asset = await this.documents.get(assetDt, String(rep.asset));
      await this.setAsset(String(rep.asset), {
        gross_purchase_amount: Number(asset.gross_purchase_amount ?? 0) - cost,
        value_after_depreciation: Number(asset.value_after_depreciation ?? 0) - cost,
      });
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Asset Repair"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(rep.name)],
    );
  }

  /**
   * Asset Disposal (scrap or sale): remove the asset from the books — Dr
   * Accumulated Depreciation + Dr Cash (sale proceeds), Cr the fixed-asset cost,
   * and book the balancing gain (Cr) or loss (Dr) against the difference between
   * sale proceeds and book value. Marks the asset Scrapped/Sold; cancel reverses.
   */
  @OnEvent("doc.on_submit:Asset Disposal")
  async onDisposalSubmit(payload: DocEventPayload): Promise<void> {
    const dis = payload.doc;
    const assetDt = this.registry.get("Asset");
    if (!assetDt || !this.registry.has("GL Entry")) return;
    const ctx = systemContext(payload.user);

    try {
      const asset = await this.documents.get(assetDt, String(dis.asset));
      const gross = Number(asset.gross_purchase_amount ?? 0);
      const accum = Number(asset.accumulated_depreciation ?? 0);
      const bookValue = gross - accum;
      const sale = String(dis.disposal_type) === "Sale" ? Number(dis.sale_amount ?? 0) : 0;
      const gainLoss = sale - bookValue;
      const gainLossAcct = String(dis.gain_loss_account || DISPOSAL_GAIN_LOSS);

      const lines = [
        { account: ACCUMULATED, debit: accum, credit: 0 },
        { account: String(dis.cash_account || CASH), debit: sale, credit: 0 },
        { account: FIXED_ASSETS, debit: 0, credit: gross },
        {
          account: gainLossAcct,
          debit: gainLoss < 0 ? -gainLoss : 0,
          credit: gainLoss > 0 ? gainLoss : 0,
        },
      ];
      await this.postGl(ctx, "Asset Disposal", String(dis.name), dis.disposal_date, String(dis.asset ?? ""), lines);

      await this.setAsset(String(dis.asset), {
        status: String(dis.disposal_type) === "Sale" ? "Sold" : "Scrapped",
        value_after_depreciation: 0,
      });
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Asset Disposal"))}
         SET ${quoteIdent("book_value")} = $1, ${quoteIdent("gain_loss")} = $2 WHERE ${quoteIdent("name")} = $3`,
        [bookValue, gainLoss, String(dis.name)],
      );
      this.logger.log(`Asset Disposal ${dis.name}: ${dis.asset} book ${bookValue}, gain/loss ${gainLoss}`);
    } catch (err) {
      this.logger.error(`Asset Disposal ${dis.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Asset Disposal")
  async onDisposalCancel(payload: DocEventPayload): Promise<void> {
    const dis = payload.doc;
    await this.reverseGl("Asset Disposal", dis.name);
    const assetDt = this.registry.get("Asset");
    if (!assetDt || !dis.asset) return;
    const asset = await this.documents.get(assetDt, String(dis.asset));
    const gross = Number(asset.gross_purchase_amount ?? 0);
    const accum = Number(asset.accumulated_depreciation ?? 0);
    const salvage = Number(asset.salvage_value ?? 0);
    const value = gross - accum;
    await this.setAsset(String(dis.asset), {
      value_after_depreciation: value,
      status: accum <= 0.0001 ? "Submitted" : value <= salvage + 0.0001 ? "Fully Depreciated" : "Partially Depreciated",
    });
  }

  @OnEvent("doc.on_submit:Asset Movement")
  async onMovementSubmit(payload: DocEventPayload): Promise<void> {
    const mv = payload.doc;
    const assetDt = this.registry.get("Asset");
    if (!assetDt || !mv.asset) return;
    try {
      const asset = await this.documents.get(assetDt, String(mv.asset));
      const from = (asset.location as string) ?? null;
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Asset Movement"))} SET ${quoteIdent("from_location")} = $1
         WHERE ${quoteIdent("name")} = $2`,
        [from, String(mv.name)],
      );
      await this.setAsset(String(mv.asset), {
        location: mv.to_location ?? from,
        custodian: mv.to_custodian ?? asset.custodian ?? null,
      });
      this.logger.log(`Asset Movement ${mv.name}: ${mv.asset} ${from ?? "-"} -> ${mv.to_location}`);
    } catch (err) {
      this.logger.error(`Asset Movement ${mv.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Asset Movement")
  async onMovementCancel(payload: DocEventPayload): Promise<void> {
    const mv = payload.doc;
    if (!this.registry.has("Asset") || !mv.asset) return;
    await this.setAsset(String(mv.asset), { location: (mv.from_location as string) ?? null });
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
