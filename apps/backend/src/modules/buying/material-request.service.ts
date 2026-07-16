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

/** Tolerance so floating-point sums don't trip an exact-quantity comparison. */
const TOL = 0.0001;

/**
 * Material Request fulfilment. A submitted Purchase Material Request can raise a
 * draft Purchase Order for its outstanding lines; each Purchase Order line links
 * back to the request item, and on the order's submit (or cancel) the request's
 * per-item `ordered_qty` and status are recomputed (Pending → Partially Ordered
 * → Ordered). A request can be Stopped to halt further ordering, enforced by a
 * before_submit gate on the Purchase Order. Pure use of the generic
 * DocumentService over sibling tables; no cross-module service imports.
 */
@Injectable()
export class MaterialRequestService {
  private readonly logger = new Logger(MaterialRequestService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Create a draft Purchase Order from a submitted Purchase Material Request,
   * one line per still-outstanding item (requested − already ordered), linking
   * each line back to the request item. Refuses a non-submitted, stopped, or
   * fully-ordered request.
   */
  async makePurchaseOrder(mrName: string, supplier: string, ctx?: UserContext): Promise<string> {
    const mrDt = this.registry.get("Material Request");
    const poDt = this.registry.get("Purchase Order");
    if (!mrDt || !poDt) throw new BadRequestException("Material Request / Purchase Order not registered");
    if (!supplier) throw new BadRequestException("A supplier is required");
    const context = ctx ?? systemContext();

    const mr = await this.documents.get(mrDt, mrName);
    if ((mr.docstatus ?? 0) !== 1) throw new BadRequestException("Material Request must be submitted");
    if (Boolean(mr.is_stopped)) throw new BadRequestException(`Material Request ${mrName} is stopped`);
    if (String(mr.material_request_type ?? "Purchase") !== "Purchase") {
      throw new BadRequestException("Only a Purchase Material Request can raise a Purchase Order");
    }

    const lines: Array<Record<string, unknown>> = [];
    for (const row of (mr.items as Array<Record<string, unknown>>) ?? []) {
      const remaining = Number(row.qty ?? 0) - Number(row.ordered_qty ?? 0);
      if (remaining <= TOL) continue;
      lines.push({
        item_code: row.item_code,
        qty: remaining,
        rate: Number(row.rate ?? 0),
        material_request: mrName,
        material_request_item: String(row.name ?? ""),
      });
    }
    if (lines.length === 0) throw new BadRequestException(`Material Request ${mrName} is already fully ordered`);

    const po = await this.documents.create(poDt, context, {
      supplier,
      transaction_date: new Date().toISOString().slice(0, 10),
      company: mr.company ?? null,
      material_request: mrName,
      items: lines,
    });
    this.logger.log(`Material Request ${mrName} -> Purchase Order ${po.name} (${lines.length} line(s))`);
    return String(po.name);
  }

  @OnEvent("doc.on_submit:Purchase Order")
  @OnEvent("doc.on_cancel:Purchase Order")
  async onPurchaseOrder(payload: DocEventPayload): Promise<void> {
    for (const mr of await this.linkedRequests(payload.doc)) {
      await this.recompute(mr);
    }
  }

  // A freshly submitted request settles to Pending (nothing ordered yet).
  @OnEvent("doc.on_submit:Material Request")
  async onMaterialRequestSubmit(payload: DocEventPayload): Promise<void> {
    await this.recompute(String(payload.doc.name));
  }

  /** Distinct Material Requests referenced by a Purchase Order's lines/header. */
  private async linkedRequests(po: Record<string, unknown>): Promise<string[]> {
    const set = new Set<string>();
    if (po.material_request) set.add(String(po.material_request));
    for (const row of (po.items as Array<Record<string, unknown>>) ?? []) {
      if (row.material_request) set.add(String(row.material_request));
    }
    return [...set];
  }

  /** Recompute a Material Request's per-item ordered_qty and overall status. */
  private async recompute(mrName: string): Promise<void> {
    if (!mrName || !this.registry.has("Material Request")) return;
    const header = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("docstatus")} AS docstatus, ${quoteIdent("is_stopped")} AS is_stopped
         FROM ${quoteIdent(tableNameFor("Material Request"))} WHERE ${quoteIdent("name")} = $1`,
        [mrName],
      )
    )[0];
    if (!header) return;

    const items: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name, ${quoteIdent("qty")} AS qty
       FROM ${quoteIdent(tableNameFor("Material Request Item"))} WHERE ${quoteIdent("parent")} = $1`,
      [mrName],
    );
    let anyOrdered = false;
    let allOrdered = items.length > 0;
    for (const item of items) {
      const ordered = await this.orderedForItem(String(item.name));
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Material Request Item"))}
         SET ${quoteIdent("ordered_qty")} = $1 WHERE ${quoteIdent("name")} = $2`,
        [ordered, String(item.name)],
      );
      if (ordered > TOL) anyOrdered = true;
      if (ordered + TOL < Number(item.qty ?? 0)) allOrdered = false;
    }

    let status: string;
    if (Number(header.is_stopped ?? 0) === 1) status = "Stopped";
    else if (Number(header.docstatus ?? 0) !== 1) status = "Draft";
    else if (allOrdered) status = "Ordered";
    else if (anyOrdered) status = "Partially Ordered";
    else status = "Pending";

    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Material Request"))}
       SET ${quoteIdent("status")} = $1 WHERE ${quoteIdent("name")} = $2`,
      [status, mrName],
    );
    this.logger.log(`Material Request ${mrName}: status ${status}`);
  }

  /** Ordered quantity for a Material Request item across submitted Purchase Orders. */
  private async orderedForItem(mrItem: string): Promise<number> {
    if (!this.registry.has("Purchase Order")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(poi.${quoteIdent("qty")}), 0) AS q
         FROM ${quoteIdent(tableNameFor("Purchase Order Item"))} poi
         JOIN ${quoteIdent(tableNameFor("Purchase Order"))} po ON po.${quoteIdent("name")} = poi.${quoteIdent("parent")}
         WHERE poi.${quoteIdent("material_request_item")} = $1 AND po.${quoteIdent("docstatus")} = 1`,
        [mrItem],
      )
    )[0];
    return Number(row?.q ?? 0);
  }

  async stop(mrName: string): Promise<{ material_request: string; status: string }> {
    await this.setStopped(mrName, true);
    this.logger.log(`Material Request ${mrName} stopped`);
    return { material_request: mrName, status: "Stopped" };
  }

  async reopen(mrName: string): Promise<{ material_request: string; status: string }> {
    await this.setStopped(mrName, false);
    await this.recompute(mrName);
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("status")} AS status FROM ${quoteIdent(tableNameFor("Material Request"))}
         WHERE ${quoteIdent("name")} = $1`,
        [mrName],
      )
    )[0];
    this.logger.log(`Material Request ${mrName} reopened`);
    return { material_request: mrName, status: String(row?.status ?? "") };
  }

  private async setStopped(mrName: string, stopped: boolean): Promise<void> {
    if (!this.registry.has("Material Request")) throw new BadRequestException("Material Request not registered");
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("docstatus")} AS docstatus, ${quoteIdent("is_stopped")} AS is_stopped
         FROM ${quoteIdent(tableNameFor("Material Request"))} WHERE ${quoteIdent("name")} = $1`,
        [mrName],
      )
    )[0];
    if (!row) throw new BadRequestException(`Material Request ${mrName} not found`);
    if (Number(row.docstatus ?? 0) !== 1) {
      throw new BadRequestException(`Material Request ${mrName} must be submitted to ${stopped ? "stop" : "reopen"}`);
    }
    if (stopped && Number(row.is_stopped ?? 0) === 1) throw new BadRequestException(`Material Request ${mrName} is already stopped`);
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Material Request"))}
       SET ${quoteIdent("is_stopped")} = $1${stopped ? `, ${quoteIdent("status")} = 'Stopped'` : ""}
       WHERE ${quoteIdent("name")} = $2`,
      [stopped ? 1 : 0, mrName],
    );
  }

  // suppressErrors:false so ordering against a stopped request aborts the submit.
  @OnEvent("doc.before_submit:Purchase Order", { suppressErrors: false })
  async gatePurchaseOrder(payload: DocEventPayload): Promise<void> {
    const requests = await this.linkedRequests(payload.doc);
    for (const mr of requests) {
      const row = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("is_stopped")} AS is_stopped FROM ${quoteIdent(tableNameFor("Material Request"))}
           WHERE ${quoteIdent("name")} = $1`,
          [mr],
        )
      )[0];
      if (row && Number(row.is_stopped ?? 0) === 1) {
        throw new BadRequestException(`Cannot order against Material Request ${mr} — it is stopped`);
      }
    }
  }
}
