import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

interface AttrValue {
  value: string;
  abbr: string;
}

const MAX_VARIANTS = 200;

/**
 * Item variants. A template Item (has_variants) lists the attributes it varies
 * on; `makeVariants` takes the cartesian product of each attribute's allowed
 * values and creates one child Item per combination (variant_of the template),
 * naming it by abbreviations and copying the base fields. `resolve` finds the
 * variant matching a given attribute combination, and `validate` guards the
 * template/variant invariants. Reuses the generic DocumentService.
 */
@Injectable()
export class VariantService {
  private readonly logger = new Logger(VariantService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async makeVariants(template: string, ctx?: UserContext): Promise<{ created: string[]; existing: string[] }> {
    const itemDt = this.registry.get("Item");
    if (!itemDt) throw new BadRequestException("Item not registered");
    const context = ctx ?? systemContext();
    const tpl = await this.documents.get(itemDt, template);
    if (!tpl.has_variants) throw new BadRequestException(`${template} is not a variant template`);

    const attrs = (tpl.attributes as Array<Record<string, unknown>>) ?? [];
    const attrNames = attrs.map((a) => String(a.attribute)).filter(Boolean);
    if (attrNames.length === 0) throw new BadRequestException("Template has no attributes");

    const valueLists: Array<{ attribute: string; values: AttrValue[] }> = [];
    for (const attribute of attrNames) {
      const values = await this.attributeValues(attribute);
      if (values.length === 0) throw new BadRequestException(`Attribute ${attribute} has no values`);
      valueLists.push({ attribute, values });
    }

    const combos = this.cartesian(valueLists);
    if (combos.length > MAX_VARIANTS) {
      throw new BadRequestException(`Refusing to create ${combos.length} variants (limit ${MAX_VARIANTS})`);
    }

    const created: string[] = [];
    const existing: string[] = [];
    for (const combo of combos) {
      const abbr = combo.map((c) => c.value.abbr).join("-");
      const itemCode = `${tpl.item_code}-${abbr}`;
      const itemName = `${tpl.item_name} ${combo.map((c) => c.value.value).join(" ")}`;
      const attributes = combo.map((c) => ({ attribute: c.attribute, attribute_value: c.value.value }));
      // Skip already-materialised combos so the run is idempotent (and doesn't
      // trip the uniqueness guard on re-run).
      if (await this.itemExists(itemCode)) {
        existing.push(itemCode);
        continue;
      }
      try {
        await this.documents.create(itemDt, context, {
          item_code: itemCode,
          item_name: itemName,
          item_group: tpl.item_group ?? null,
          stock_uom: tpl.stock_uom ?? null,
          standard_rate: tpl.standard_rate ?? 0,
          valuation_method: tpl.valuation_method ?? "Moving Average",
          is_stock_item: 1,
          variant_of: tpl.item_code,
          attributes,
        });
        created.push(itemCode);
      } catch (err) {
        if ((err as { status?: number }).status === 409) existing.push(itemCode);
        else throw err;
      }
    }
    this.logger.log(`Template ${template}: ${created.length} variant(s) created, ${existing.length} existing`);
    return { created, existing };
  }

  /** Find the variant of `template` whose attributes match every given pair. */
  async resolve(template: string, wanted: Record<string, string>): Promise<string | null> {
    if (!this.registry.has("Item")) return null;
    const pairs = Object.entries(wanted).filter(([, v]) => v);
    if (pairs.length === 0) return null;
    const variants = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Item"))}
       WHERE ${quoteIdent("variant_of")} = $1`,
      [template],
    );
    for (const v of variants) {
      const combo = await this.variantCombo(String(v.name));
      if (pairs.every(([attr, val]) => combo.get(attr) === val)) return String(v.name);
    }
    return null;
  }

  /**
   * Guard Item template/variant invariants: a template cannot itself be a
   * variant, and two variants of the same template cannot share an identical
   * attribute combination.
   */
  async validate(data: Record<string, unknown>, name?: string): Promise<void> {
    if (data.has_variants && data.variant_of) {
      throw new BadRequestException("An item cannot be both a template and a variant");
    }
    if (!data.variant_of) return;
    const attributes = (data.attributes as Array<Record<string, unknown>>) ?? [];
    if (attributes.length === 0) return;
    const signature = this.signature(
      attributes.map((a) => [String(a.attribute), String(a.attribute_value ?? "")]),
    );
    const siblings = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Item"))}
       WHERE ${quoteIdent("variant_of")} = $1 AND ${quoteIdent("name")} <> $2`,
      [String(data.variant_of), name ?? ""],
    );
    for (const s of siblings) {
      const combo = await this.variantCombo(String(s.name));
      if (this.signature([...combo.entries()]) === signature) {
        throw new BadRequestException(
          `Variant with this attribute combination already exists (${s.name})`,
        );
      }
    }
  }

  private async itemExists(itemCode: string): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM ${quoteIdent(tableNameFor("Item"))} WHERE ${quoteIdent("name")} = $1 LIMIT 1`,
      [itemCode],
    );
    return rows.length > 0;
  }

  private async attributeValues(attribute: string): Promise<AttrValue[]> {
    if (!this.registry.has("Item Attribute Value")) return [];
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("attribute_value")} AS value, ${quoteIdent("abbreviation")} AS abbr
       FROM ${quoteIdent(tableNameFor("Item Attribute Value"))}
       WHERE ${quoteIdent("parent")} = $1 ORDER BY ${quoteIdent("idx")}`,
      [attribute],
    );
    return rows.map((r: { value: string; abbr: string }) => ({ value: String(r.value), abbr: String(r.abbr) }));
  }

  private async variantCombo(item: string): Promise<Map<string, string>> {
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("attribute")} AS attribute, ${quoteIdent("attribute_value")} AS value
       FROM ${quoteIdent(tableNameFor("Item Variant Attribute"))} WHERE ${quoteIdent("parent")} = $1`,
      [item],
    );
    const map = new Map<string, string>();
    for (const r of rows) map.set(String(r.attribute), String(r.value ?? ""));
    return map;
  }

  private signature(pairs: Array<[string, string]>): string {
    return pairs
      .map(([a, v]) => `${a}=${v}`)
      .sort()
      .join("|");
  }

  private cartesian(
    lists: Array<{ attribute: string; values: AttrValue[] }>,
  ): Array<Array<{ attribute: string; value: AttrValue }>> {
    let acc: Array<Array<{ attribute: string; value: AttrValue }>> = [[]];
    for (const { attribute, values } of lists) {
      const next: Array<Array<{ attribute: string; value: AttrValue }>> = [];
      for (const partial of acc) {
        for (const value of values) next.push([...partial, { attribute, value }]);
      }
      acc = next;
    }
    return acc;
  }
}
