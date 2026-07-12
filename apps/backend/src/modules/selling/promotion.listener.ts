import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

interface Tier {
  min_qty: number;
  discount_percentage: number;
}

/**
 * Promotion side-effects, on the event bus:
 *
 *  1. Coupon usage — a submitted Sales Invoice carrying a coupon increments that
 *     Coupon Code's `used` count (decremented on cancel), so a max-use coupon
 *     stops unlocking its rule once exhausted.
 *  2. Promotional Scheme — on save, a scheme (re)generates one Pricing Rule per
 *     discount tier, tagged with the scheme so old rules are replaced cleanly.
 */
@Injectable()
export class PromotionListener {
  private readonly logger = new Logger(PromotionListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Sales Invoice")
  async onInvoiceSubmit(payload: DocEventPayload): Promise<void> {
    await this.bumpCoupon(payload.doc.coupon_code, 1);
  }

  @OnEvent("doc.on_cancel:Sales Invoice")
  async onInvoiceCancel(payload: DocEventPayload): Promise<void> {
    await this.bumpCoupon(payload.doc.coupon_code, -1);
  }

  private async bumpCoupon(coupon: unknown, delta: number): Promise<void> {
    if (!coupon || !this.registry.has("Coupon Code")) return;
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Coupon Code"))}
       SET ${quoteIdent("used")} = greatest(0, coalesce(${quoteIdent("used")},0) + $1)
       WHERE ${quoteIdent("name")} = $2`,
      [delta, String(coupon)],
    );
    this.logger.log(`Coupon ${coupon} usage ${delta > 0 ? "+1" : "-1"}`);
  }

  /**
   * Regenerate a Promotional Scheme's Pricing Rules: delete the rules previously
   * generated for this scheme, then create one per tier (a discount % above a
   * minimum qty), tagged back with the scheme name.
   */
  @OnEvent("doc.on_submit:Promotional Scheme")
  async onSchemeSubmit(payload: DocEventPayload): Promise<void> {
    await this.regenerate(payload.doc);
  }

  private async regenerate(scheme: Record<string, unknown>): Promise<void> {
    const prDt = this.registry.get("Pricing Rule");
    if (!prDt) return;
    const ctx = systemContext();
    const name = String(scheme.name);

    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("Pricing Rule"))} WHERE ${quoteIdent("promotional_scheme")} = $1`,
      [name],
    );

    const tiers = (scheme.tiers as Tier[]) ?? [];
    let created = 0;
    for (const tier of tiers) {
      const disc = Number(tier.discount_percentage ?? 0);
      if (disc <= 0) continue;
      await this.documents.create(prDt, ctx, {
        title: `${name} @${Number(tier.min_qty ?? 0)}+`,
        is_active: 1,
        priority: Math.round(Number(tier.min_qty ?? 0)),
        apply_on: scheme.apply_on ?? "Item Code",
        item_code: scheme.item_code ?? null,
        item_group: scheme.item_group ?? null,
        customer: scheme.customer ?? null,
        min_qty: Number(tier.min_qty ?? 0),
        rate_or_discount: "Discount Percentage",
        discount_percentage: disc,
        promotional_scheme: name,
      });
      created += 1;
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Promotional Scheme"))} SET ${quoteIdent("status")} = 'Active'
       WHERE ${quoteIdent("name")} = $1`,
      [name],
    );
    this.logger.log(`Promotional Scheme ${name}: generated ${created} pricing rule(s)`);
  }

  @OnEvent("doc.on_cancel:Promotional Scheme")
  async onSchemeCancel(payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Pricing Rule")) return;
    await this.dataSource.query(
      `DELETE FROM ${quoteIdent(tableNameFor("Pricing Rule"))} WHERE ${quoteIdent("promotional_scheme")} = $1`,
      [String(payload.doc.name)],
    );
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Promotional Scheme"))} SET ${quoteIdent("status")} = 'Cancelled'
       WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }
}
