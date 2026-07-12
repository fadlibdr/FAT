import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
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

  private async workstationRate(workstation: string): Promise<number> {
    if (!workstation || !this.registry.has("Workstation")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("hour_rate")} AS r FROM ${quoteIdent(tableNameFor("Workstation"))}
         WHERE ${quoteIdent("name")} = $1`,
        [workstation],
      )
    )[0];
    return Number(row?.r ?? 0);
  }

  /**
   * BOM costing: on save, price each operation (time_in_mins/60 × workstation
   * hour rate) and roll raw-material + operating costs into the BOM totals.
   * Mutates the raw input in place before it is written.
   */
  @OnEvent("doc.before_save:BOM")
  async onBomSave(payload: BeforeSavePayload): Promise<void> {
    const data = payload.data;
    const items = (data.items as Array<Record<string, unknown>>) ?? [];
    const rawMaterialCost = items.reduce((s, r) => s + Number(r.qty ?? 0) * Number(r.rate ?? 0), 0);

    let operatingCost = 0;
    const operations = (data.operations as Array<Record<string, unknown>>) ?? [];
    for (const op of operations) {
      const rate = await this.workstationRate(String(op.workstation ?? ""));
      const cost = (Number(op.time_in_mins ?? 0) / 60) * rate;
      op.operating_cost = Math.round(cost * 100) / 100;
      operatingCost += Number(op.operating_cost);
    }

    data.raw_material_cost = Math.round(rawMaterialCost * 100) / 100;
    data.operating_cost = Math.round(operatingCost * 100) / 100;
    data.total_cost = Math.round((rawMaterialCost + operatingCost) * 100) / 100;
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
      // Operations add labour cost; a Job Card records each on the shop floor.
      const opValue = await this.createJobCards(ctx, wo, bom, scale, woQty);

      // Finished good is valued at rolled-up material + operating cost per unit.
      const fgRate = woQty > 0 ? (rmValue + opValue) / woQty : 0;
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
        produced_value: rmValue + opValue,
      });
      this.logger.log(
        `Work Order ${wo.name} manufactured ${woQty} via ${se.name} (material ${rmValue} + labour ${opValue})`,
      );
    } catch (err) {
      this.logger.error(`Work Order ${wo.name} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Create a Job Card per BOM operation (scaled to the Work Order qty) and
   * return the total operating cost that will be capitalised into the finished
   * good. Returns 0 when the BOM has no operations.
   */
  private async createJobCards(
    ctx: ReturnType<typeof systemContext>,
    wo: Record<string, unknown>,
    bom: Record<string, unknown>,
    scale: number,
    woQty: number,
  ): Promise<number> {
    const jcDt = this.registry.get("Job Card");
    const operations = (bom.operations as Array<Record<string, unknown>>) ?? [];
    let opValue = 0;
    for (const op of operations) {
      const cost = Number(op.operating_cost ?? 0) * scale;
      const mins = Number(op.time_in_mins ?? 0) * scale;
      opValue += cost;
      if (!jcDt) continue;
      try {
        await this.documents.create(jcDt, ctx, {
          work_order: wo.name,
          operation: op.operation ?? null,
          workstation: op.workstation ?? null,
          for_quantity: woQty,
          time_in_mins: Math.round(mins * 100) / 100,
          operating_cost: Math.round(cost * 100) / 100,
          status: "Completed",
        });
      } catch (err) {
        this.logger.error(`Job Card for ${wo.name}/${op.operation}: ${(err as Error).message}`);
      }
    }
    return Math.round(opValue * 100) / 100;
  }

  /**
   * A submitted Production Plan spins up a draft Work Order per planned item
   * (left in draft so the planner can schedule and submit each one), links it
   * back onto the plan row, and marks the plan Submitted.
   */
  @OnEvent("doc.on_submit:Production Plan")
  async onProductionPlanSubmit(payload: DocEventPayload): Promise<void> {
    const plan = payload.doc;
    const woDt = this.registry.get("Work Order");
    if (!woDt) return;
    const ctx = systemContext(payload.user);
    for (const row of (plan.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.planned_qty ?? 0);
      if (!row.item_code || !row.bom || qty <= 0) continue;
      try {
        const wo = await this.documents.create(woDt, ctx, {
          production_item: row.item_code,
          bom: row.bom,
          qty,
          company: plan.company ?? null,
          status: "Draft",
        });
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Production Plan Item"))}
           SET ${quoteIdent("work_order")} = $1 WHERE ${quoteIdent("name")} = $2`,
          [String(wo.name), String(row.name)],
        );
        this.logger.log(`Production Plan ${plan.name}: created Work Order ${wo.name} for ${row.item_code}`);
      } catch (err) {
        this.logger.error(`Production Plan ${plan.name}/${row.item_code}: ${(err as Error).message}`);
      }
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Production Plan"))} SET ${quoteIdent("status")} = 'Submitted'
       WHERE ${quoteIdent("name")} = $1`,
      [String(plan.name)],
    );
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
    if (this.registry.has("Job Card")) {
      await this.dataSource.query(
        `DELETE FROM ${quoteIdent(tableNameFor("Job Card"))} WHERE ${quoteIdent("work_order")} = $1`,
        [String(wo.name)],
      );
    }
    await this.setWorkOrder(String(wo.name), { status: "Cancelled" });
  }
}
