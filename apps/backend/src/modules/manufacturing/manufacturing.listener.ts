import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Turns a submitted Work Order into a Manufacture Stock Entry: it consumes the
 * BOM's raw materials from the source warehouse and receives the finished good
 * into the target warehouse, valued at the rolled-up cost of those materials.
 * Pure event-bus listener — Manufacturing imports no other module's services.
 */
@Injectable()
export class ManufacturingListener {
  private readonly logger = new Logger(ManufacturingListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Current moving-average valuation for an item, falling back to standard rate. */
  private async valuationRate(item: string): Promise<number> {
    const bin = (
      await this.dataSource.query(
        `SELECT sum(${quoteIdent("stock_value")}) AS v, sum(${quoteIdent("actual_qty")}) AS q
         FROM ${quoteIdent(tableNameFor("Bin"))} WHERE ${quoteIdent("item_code")} = $1`,
        [item],
      )
    )[0];
    const q = Number(bin?.q ?? 0);
    if (q > 0) return Number(bin?.v ?? 0) / q;
    const it = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("standard_rate")} AS r FROM ${quoteIdent(tableNameFor("Item"))} WHERE ${quoteIdent("name")} = $1`,
        [item],
      )
    )[0];
    return Number(it?.r ?? 0);
  }

  private async setWorkOrder(name: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Work Order"))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  @OnEvent("doc.on_submit:Work Order")
  async onWorkOrderSubmit(payload: DocEventPayload): Promise<void> {
    const wo = payload.doc;
    const ctx = systemContext(payload.user);
    const bomDt = this.registry.get("BOM");
    const seDt = this.registry.get("Stock Entry");
    if (!bomDt || !seDt) return;

    try {
      const bom = await this.documents.get(bomDt, String(wo.bom));
      const bomQty = Number(bom.quantity ?? 1) || 1;
      const woQty = Number(wo.qty ?? 0);
      const scale = woQty / bomQty;
      const source = (wo.source_warehouse as string) || null;
      const target = (wo.fg_warehouse as string) || null;

      const items: Array<Record<string, unknown>> = [];
      let rmValue = 0;
      for (const rm of (bom.items as Array<Record<string, unknown>>) ?? []) {
        const rmQty = Number(rm.qty ?? 0) * scale;
        if (!rmQty) continue;
        const rate = rm.rate != null && rm.rate !== ""
          ? Number(rm.rate)
          : await this.valuationRate(String(rm.item_code));
        rmValue += rmQty * rate;
        items.push({ item_code: rm.item_code, qty: rmQty, s_warehouse: source });
      }
      // Finished good receives the rolled-up per-unit cost.
      const fgRate = woQty > 0 ? rmValue / woQty : 0;
      items.push({ item_code: wo.production_item, qty: woQty, t_warehouse: target, basic_rate: fgRate });

      const se = await this.documents.create(seDt, ctx, {
        purpose: "Manufacture",
        posting_date: wo.posting_date ?? new Date().toISOString().slice(0, 10),
        company: wo.company ?? null,
        work_order: wo.name,
        items,
      });
      await this.documents.setDocStatus(seDt, ctx, String(se.name), 1);

      await this.setWorkOrder(String(wo.name), {
        status: "Completed",
        stock_entry: se.name,
        produced_value: rmValue,
      });
      this.logger.log(`Work Order ${wo.name} manufactured ${woQty} via ${se.name} (value ${rmValue})`);
    } catch (err) {
      this.logger.error(`Work Order ${wo.name} failed: ${(err as Error).message}`);
    }
  }

  @OnEvent("doc.on_cancel:Work Order")
  async onWorkOrderCancel(payload: DocEventPayload): Promise<void> {
    const wo = payload.doc;
    const ctx = systemContext(payload.user);
    const seDt = this.registry.get("Stock Entry");
    if (seDt && wo.stock_entry) {
      try {
        const se = await this.documents.get(seDt, String(wo.stock_entry));
        if ((se.docstatus ?? 0) === 1) {
          await this.documents.setDocStatus(seDt, ctx, String(wo.stock_entry), 2);
        }
      } catch (err) {
        this.logger.error(`Reversing Work Order ${wo.name} entry failed: ${(err as Error).message}`);
      }
    }
    await this.setWorkOrder(String(wo.name), { status: "Cancelled" });
  }
}
