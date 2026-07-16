import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Small tolerance for float slab-boundary comparisons. */
const TOL = 0.0001;

/**
 * Shipping Rule. Two pure before_save behaviours, no cross-module imports:
 *
 *  1. Shipping Rule — validate its condition slabs: each `from_value` must not
 *     exceed its `to_value`, and slabs must not overlap.
 *  2. Sales Order — when it carries a `shipping_rule`, compute `shipping_charge`
 *     from the slab matching the order's base value (total amount or total qty,
 *     per the rule's `calculate_based_on`). No match → zero charge.
 */
@Injectable()
export class ShippingRuleListener {
  private readonly logger = new Logger(ShippingRuleListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so an invalid slab set aborts the save.
  @OnEvent("doc.before_save:Shipping Rule", { suppressErrors: false })
  onRuleSave(payload: BeforeSavePayload): void {
    const conditions = (payload.data.conditions as Array<Record<string, unknown>>) ?? [];
    const slabs = conditions.map((c) => ({ from: Number(c.from_value ?? 0), to: Number(c.to_value ?? 0) }));
    for (const s of slabs) {
      if (s.to > 0 && s.from > s.to + TOL) {
        throw new BadRequestException(`Shipping Rule condition from ${s.from} cannot exceed to ${s.to}`);
      }
    }
    // Overlap check: sort by from and ensure each starts after the previous ends.
    const sorted = [...slabs].sort((a, b) => a.from - b.from);
    for (let i = 1; i < sorted.length; i++) {
      const prevTo = sorted[i - 1].to > 0 ? sorted[i - 1].to : Number.POSITIVE_INFINITY;
      if (sorted[i].from < prevTo - TOL) {
        throw new BadRequestException(
          `Shipping Rule slabs overlap near ${sorted[i].from} (previous ends at ${sorted[i - 1].to})`,
        );
      }
    }
  }

  @OnEvent("doc.before_save:Sales Order")
  async onOrderSave(payload: BeforeSavePayload): Promise<void> {
    const d = payload.data;
    const rule = String(d.shipping_rule ?? "");
    if (!rule || !this.registry.has("Shipping Rule")) {
      if (!rule) d.shipping_charge = 0;
      return;
    }
    const header = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("calculate_based_on")} AS basis FROM ${quoteIdent(tableNameFor("Shipping Rule"))}
         WHERE ${quoteIdent("name")} = $1`,
        [rule],
      )
    )[0];
    if (!header) {
      d.shipping_charge = 0;
      return;
    }
    const items = (d.items as Array<Record<string, unknown>>) ?? [];
    const basis = String(header.basis ?? "Amount");
    const base =
      basis === "Quantity"
        ? items.reduce((s, r) => s + Number(r.qty ?? 0), 0)
        : items.reduce((s, r) => s + Number(r.qty ?? 0) * Number(r.rate ?? 0), 0);

    const conditions: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("from_value")} AS from_value, ${quoteIdent("to_value")} AS to_value,
              ${quoteIdent("shipping_amount")} AS shipping_amount
       FROM ${quoteIdent(tableNameFor("Shipping Rule Condition"))} WHERE ${quoteIdent("parent")} = $1`,
      [rule],
    );
    let charge = 0;
    for (const c of conditions) {
      const from = Number(c.from_value ?? 0);
      const to = Number(c.to_value ?? 0);
      const upper = to > 0 ? to : Number.POSITIVE_INFINITY;
      if (base + TOL >= from && base <= upper + TOL) {
        charge = Number(c.shipping_amount ?? 0);
        break;
      }
    }
    d.shipping_charge = charge;
    this.logger.log(`Sales Order shipping via ${rule}: base ${base} (${basis}) -> charge ${charge}`);
  }
}
