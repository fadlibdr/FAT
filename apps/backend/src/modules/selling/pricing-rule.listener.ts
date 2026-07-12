import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

interface Rule {
  name: string;
  priority: number;
  apply_on: string;
  item_code: string | null;
  item_group: string | null;
  customer: string | null;
  min_qty: number;
  rate_or_discount: string;
  discount_percentage: number;
  rate: number;
  coupon_based: number;
  price_or_product_discount: string;
  free_item: string | null;
  free_qty: number;
}

/**
 * Applies Pricing Rules to selling transaction lines before they are written.
 * On `before_save`, for any document carrying a `customer` and an `items` table,
 * each line is matched against active Pricing Rules (by item code or item group,
 * optionally scoped to the customer, above a minimum qty); the highest-priority
 * match sets the line's rate (fixed Rate) or applies a Discount % off the entered
 * price. The engine's recompute-totals job then derives amounts/totals from the
 * adjusted rates. Pure event-bus listener — no cross-module service imports.
 */
@Injectable()
export class PricingRuleListener {
  private readonly logger = new Logger(PricingRuleListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.before_save")
  async onBeforeSave(payload: BeforeSavePayload): Promise<void> {
    if (!this.registry.has("Pricing Rule")) return;
    const data = payload.data;
    const items = data.items as Array<Record<string, unknown>> | undefined;
    // Only price billing transactions: a customer + an items grid, and a
    // grand_total field (Quotation / Sales Order / Sales Invoice) — not
    // pre-sales docs like Opportunity, which would otherwise double-discount
    // when their lines are carried into a converted Quotation.
    if (!data.customer || !Array.isArray(items) || items.length === 0) return;
    if (!items.some((r) => r && r.item_code !== undefined)) return;
    const dt = this.registry.get(payload.doctype);
    if (!dt || !dt.fields.some((f) => f.fieldname === "grand_total")) return;

    const rules = (await this.dataSource.query(
      `SELECT ${quoteIdent("name")}, coalesce(${quoteIdent("priority")},0) AS priority,
              ${quoteIdent("apply_on")}, ${quoteIdent("item_code")}, ${quoteIdent("item_group")},
              ${quoteIdent("customer")}, coalesce(${quoteIdent("min_qty")},0) AS min_qty,
              ${quoteIdent("rate_or_discount")}, coalesce(${quoteIdent("discount_percentage")},0) AS discount_percentage,
              coalesce(${quoteIdent("rate")},0) AS rate, coalesce(${quoteIdent("coupon_based")},0) AS coupon_based,
              coalesce(${quoteIdent("price_or_product_discount")},'Price') AS price_or_product_discount,
              ${quoteIdent("free_item")}, coalesce(${quoteIdent("free_qty")},0) AS free_qty
       FROM ${quoteIdent(tableNameFor("Pricing Rule"))}
       WHERE ${quoteIdent("is_active")} = 1`,
    )) as Rule[];
    if (rules.length === 0) return;

    // A coupon on the document unlocks exactly its (valid, non-exhausted) rule;
    // coupon-based rules never apply without it.
    const couponRule = await this.resolveCoupon(data.coupon_code as string | undefined);

    const customer = String(data.customer);
    const freeLines: Array<Record<string, unknown>> = [];
    for (const line of items) {
      const itemCode = line.item_code ? String(line.item_code) : "";
      if (!itemCode) continue;
      const qty = Number(line.qty ?? 0);
      const group = await this.itemGroup(itemCode);

      const match = rules
        .filter((r) => this.matches(r, itemCode, group, customer, qty, couponRule))
        .sort((a, b) => b.priority - a.priority)[0];
      if (!match) continue;

      // Product promotion: add a free line instead of discounting the matched one.
      if (match.price_or_product_discount === "Product" && match.free_item) {
        const already = items.some(
          (l) => String(l.item_code) === String(match.free_item) && Number(l.rate ?? 0) === 0,
        );
        if (!already && !freeLines.some((l) => l.item_code === match.free_item)) {
          freeLines.push({ item_code: match.free_item, qty: Number(match.free_qty) || 1, rate: 0 });
          this.logger.log(`Pricing Rule ${match.name}: free item ${match.free_item} added`);
        }
        continue;
      }

      const baseRate = Number(line.rate ?? 0) || (await this.itemStandardRate(itemCode));
      if (match.rate_or_discount === "Rate") {
        line.rate = match.rate;
        line.discount_percentage = 0;
      } else {
        const disc = Number(match.discount_percentage);
        line.rate = baseRate * (1 - disc / 100);
        line.discount_percentage = disc;
      }
      this.logger.log(
        `Pricing Rule ${match.name} applied to ${itemCode}: rate ${baseRate} -> ${line.rate}`,
      );
    }
    if (freeLines.length) data.items = [...items, ...freeLines];
  }

  /** Resolve a document's coupon to its pricing-rule name, if valid and available. */
  private async resolveCoupon(couponCode: string | undefined): Promise<string | null> {
    if (!couponCode || !this.registry.has("Coupon Code")) return null;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("pricing_rule")} AS rule, ${quoteIdent("valid_upto")} AS valid_upto,
                coalesce(${quoteIdent("max_use")},0) AS max_use, coalesce(${quoteIdent("used")},0) AS used
         FROM ${quoteIdent(tableNameFor("Coupon Code"))} WHERE ${quoteIdent("name")} = $1`,
        [couponCode],
      )
    )[0];
    if (!row || !row.rule) return null;
    if (row.valid_upto && new Date(row.valid_upto) < new Date(new Date().toISOString().slice(0, 10))) {
      return null;
    }
    if (Number(row.max_use) > 0 && Number(row.used) >= Number(row.max_use)) return null;
    return String(row.rule);
  }

  private matches(
    r: Rule,
    itemCode: string,
    group: string,
    customer: string,
    qty: number,
    couponRule: string | null,
  ): boolean {
    if (Number(r.coupon_based) === 1 && r.name !== couponRule) return false;
    if (r.customer && r.customer !== customer) return false;
    if (qty < Number(r.min_qty ?? 0)) return false;
    if (r.apply_on === "Item Group") return !!r.item_group && r.item_group === group;
    return !!r.item_code && r.item_code === itemCode;
  }

  private async itemGroup(itemCode: string): Promise<string> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("item_group")} AS g FROM ${quoteIdent(tableNameFor("Item"))}
         WHERE ${quoteIdent("name")} = $1`,
        [itemCode],
      )
    )[0];
    return row?.g ? String(row.g) : "";
  }

  private async itemStandardRate(itemCode: string): Promise<number> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("standard_rate")} AS r FROM ${quoteIdent(tableNameFor("Item"))}
         WHERE ${quoteIdent("name")} = $1`,
        [itemCode],
      )
    )[0];
    return Number(row?.r ?? 0);
  }
}
