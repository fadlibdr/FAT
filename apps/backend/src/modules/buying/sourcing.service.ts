import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

export interface ItemComparison {
  item_code: string;
  quotes: Array<{ supplier: string; supplier_quotation: string; rate: number }>;
  lowest?: { supplier: string; supplier_quotation: string; rate: number };
}

/**
 * Procurement sourcing. A submitted Request for Quotation fans out into one
 * draft Supplier Quotation per invited supplier (pre-filled with the RFQ items
 * at zero rate); suppliers fill in and submit their quotes; a comparison ranks
 * quotes per item; and a chosen quotation becomes a draft Purchase Order. Reuses
 * the generic DocumentService — Buying imports no other module's services.
 */
@Injectable()
export class SourcingService {
  private readonly logger = new Logger(SourcingService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Request for Quotation")
  async onRfqSubmit(payload: DocEventPayload): Promise<void> {
    const rfq = payload.doc;
    const sqDt = this.registry.get("Supplier Quotation");
    if (!sqDt) return;
    const ctx = systemContext(payload.user);
    const items = (rfq.items as Array<Record<string, unknown>>) ?? [];
    const lines = items.map((r) => ({ item_code: r.item_code, qty: Number(r.qty ?? 0), rate: 0 }));

    for (const sup of (rfq.suppliers as Array<Record<string, unknown>>) ?? []) {
      const supplier = String(sup.supplier ?? "");
      if (!supplier) continue;
      try {
        const sq = await this.documents.create(sqDt, ctx, {
          supplier,
          transaction_date: rfq.transaction_date ?? null,
          request_for_quotation: rfq.name,
          company: rfq.company ?? null,
          status: "Draft",
          items: lines,
        });
        await this.dataSource.query(
          `UPDATE ${quoteIdent(tableNameFor("Request for Quotation Supplier"))}
           SET ${quoteIdent("supplier_quotation")} = $1 WHERE ${quoteIdent("name")} = $2`,
          [String(sq.name), String(sup.name)],
        );
        this.logger.log(`RFQ ${rfq.name}: created Supplier Quotation ${sq.name} for ${supplier}`);
      } catch (err) {
        this.logger.error(`RFQ ${rfq.name}/${supplier}: ${(err as Error).message}`);
      }
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Request for Quotation"))}
       SET ${quoteIdent("status")} = 'Submitted' WHERE ${quoteIdent("name")} = $1`,
      [String(rfq.name)],
    );
  }

  @OnEvent("doc.on_submit:Supplier Quotation")
  async onSqSubmit(payload: DocEventPayload): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Supplier Quotation"))}
       SET ${quoteIdent("status")} = 'Submitted'
       WHERE ${quoteIdent("name")} = $1 AND ${quoteIdent("status")} <> 'Ordered'`,
      [String(payload.doc.name)],
    );
  }

  @OnEvent("doc.on_cancel:Supplier Quotation")
  async onSqCancel(payload: DocEventPayload): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Supplier Quotation"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
  }

  /** Per-item quotes from every submitted Supplier Quotation for an RFQ, lowest flagged. */
  async compare(rfq: string): Promise<ItemComparison[]> {
    if (!this.registry.has("Supplier Quotation")) return [];
    const rows = await this.dataSource.query(
      `SELECT sqi.${quoteIdent("item_code")} AS item_code, sq.${quoteIdent("supplier")} AS supplier,
              sq.${quoteIdent("name")} AS supplier_quotation, coalesce(sqi.${quoteIdent("rate")},0) AS rate
       FROM ${quoteIdent(tableNameFor("Supplier Quotation Item"))} sqi
       JOIN ${quoteIdent(tableNameFor("Supplier Quotation"))} sq ON sq.${quoteIdent("name")} = sqi.${quoteIdent("parent")}
       WHERE sq.${quoteIdent("request_for_quotation")} = $1 AND sq.${quoteIdent("docstatus")} = 1
       ORDER BY sqi.${quoteIdent("item_code")}, coalesce(sqi.${quoteIdent("rate")},0)`,
      [rfq],
    );
    const byItem = new Map<string, ItemComparison>();
    for (const r of rows) {
      const key = String(r.item_code);
      const quote = { supplier: String(r.supplier), supplier_quotation: String(r.supplier_quotation), rate: Number(r.rate) };
      if (!byItem.has(key)) byItem.set(key, { item_code: key, quotes: [] });
      byItem.get(key)!.quotes.push(quote);
    }
    for (const comp of byItem.values()) {
      comp.lowest = comp.quotes.reduce((lo, q) => (lo && lo.rate <= q.rate ? lo : q), comp.quotes[0]);
    }
    return [...byItem.values()];
  }

  /**
   * Create a draft Request for Quotation from a submitted Purchase Material
   * Request: copy the requested items and invite the given suppliers, linking the
   * RFQ back to the material request. When the RFQ is later submitted, onRfqSubmit
   * fans out one Supplier Quotation per invited supplier — completing the funnel
   * Material Request → RFQ → Supplier Quotation → Purchase Order.
   */
  async makeRequestForQuotation(mrName: string, suppliers: string[] = [], ctx?: UserContext): Promise<string> {
    const mrDt = this.registry.get("Material Request");
    const rfqDt = this.registry.get("Request for Quotation");
    if (!mrDt || !rfqDt) throw new BadRequestException("Material Request or Request for Quotation not registered");
    const context = ctx ?? systemContext();
    const mr = await this.documents.get(mrDt, mrName);
    if ((mr.docstatus ?? 0) !== 1) throw new BadRequestException("Material Request must be submitted");
    if (String(mr.material_request_type ?? "Purchase") !== "Purchase") {
      throw new BadRequestException("Only a Purchase Material Request can raise a Request for Quotation");
    }

    const items = ((mr.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      warehouse: r.warehouse ?? null,
    }));
    if (items.length === 0) throw new BadRequestException(`Material Request ${mrName} has no items`);

    const invited = [...new Set(suppliers.filter(Boolean).map(String))].map((supplier) => ({ supplier }));
    const rfq = await this.documents.create(rfqDt, context, {
      transaction_date: mr.transaction_date ?? new Date().toISOString().slice(0, 10),
      company: mr.company ?? null,
      material_request: mrName,
      items,
      suppliers: invited,
    });
    this.logger.log(
      `Material Request ${mrName} -> Request for Quotation ${rfq.name} (${items.length} items, ${invited.length} suppliers)`,
    );
    return String(rfq.name);
  }

  /** Create a draft Purchase Order from a submitted Supplier Quotation. */
  async makePurchaseOrder(sqName: string, ctx?: UserContext): Promise<string> {
    const sqDt = this.registry.get("Supplier Quotation");
    const poDt = this.registry.get("Purchase Order");
    if (!sqDt || !poDt) throw new BadRequestException("Buying doctypes not registered");
    const context = ctx ?? systemContext();

    const sq = await this.documents.get(sqDt, sqName);
    if ((sq.docstatus ?? 0) !== 1) throw new BadRequestException("Supplier Quotation must be submitted");
    if (String(sq.status) === "Ordered") {
      throw new BadRequestException(`Supplier Quotation ${sqName} is already Ordered`);
    }

    const poItems = ((sq.items as Array<Record<string, unknown>>) ?? []).map((r) => ({
      item_code: r.item_code,
      qty: Number(r.qty ?? 0),
      rate: Number(r.rate ?? 0),
    }));
    const po = await this.documents.create(poDt, context, {
      supplier: sq.supplier,
      transaction_date: new Date().toISOString().slice(0, 10),
      company: sq.company ?? null,
      items: poItems,
    });

    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Supplier Quotation"))}
       SET ${quoteIdent("status")} = 'Ordered', ${quoteIdent("purchase_order")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [String(po.name), sqName],
    );
    this.logger.log(`Supplier Quotation ${sqName} -> Purchase Order ${po.name} (${sq.supplier})`);
    return String(po.name);
  }
}
