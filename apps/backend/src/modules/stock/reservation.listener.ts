import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Stock reservation & availability. Pure event-bus listener, no cross-module
 * imports:
 *
 *  1. before_submit on a Stock Reservation blocks reserving more than is
 *     available (on-hand minus what is already reserved); submit/cancel flip
 *     the reservation's status.
 *  2. before_submit on a Delivery Note blocks issuing more of an item than is
 *     physically on hand in the source warehouse.
 */
@Injectable()
export class ReservationListener {
  private readonly logger = new Logger(ReservationListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** On-hand quantity for an item+warehouse (batch-agnostic bin). */
  private async onHand(item: string, warehouse: string, batch = ""): Promise<number> {
    if (!this.registry.has("Bin")) return 0;
    // Bins are keyed item::warehouse::batch — a batched line checks its own batch's
    // balance, an unbatched line the plain (empty-batch) bin.
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("actual_qty")} AS qty FROM ${quoteIdent(tableNameFor("Bin"))}
         WHERE ${quoteIdent("name")} = $1`,
        [`${item}::${warehouse}::${batch}`],
      )
    )[0];
    return Number(row?.qty ?? 0);
  }

  /** Total submitted reservation for an item+warehouse, optionally excluding one. */
  private async reserved(item: string, warehouse: string, exclude?: string): Promise<number> {
    if (!this.registry.has("Stock Reservation")) return 0;
    const params: unknown[] = [item, warehouse];
    let sql = `SELECT coalesce(sum(${quoteIdent("qty")}), 0) AS q
               FROM ${quoteIdent(tableNameFor("Stock Reservation"))}
               WHERE ${quoteIdent("item_code")} = $1 AND ${quoteIdent("warehouse")} = $2
                 AND ${quoteIdent("docstatus")} = 1`;
    if (exclude) {
      params.push(exclude);
      sql += ` AND ${quoteIdent("name")} <> $3`;
    }
    return Number((await this.dataSource.query(sql, params))[0]?.q ?? 0);
  }

  private async setStatus(name: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Stock Reservation"))} SET ${quoteIdent("status")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [status, name],
    );
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Stock Reservation", { suppressErrors: false })
  async gateReservation(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const item = String(doc.item_code ?? "");
    const wh = String(doc.warehouse ?? "");
    const qty = Number(doc.qty ?? 0);
    if (!item || !wh || !qty) return;
    const available = (await this.onHand(item, wh)) - (await this.reserved(item, wh, String(doc.name)));
    if (qty > available + 1e-9) {
      throw new BadRequestException(
        `Stock Reservation ${doc.name}: cannot reserve ${qty} of ${item} at ${wh} — only ${available} available`,
      );
    }
  }

  @OnEvent("doc.on_submit:Stock Reservation")
  async onReservationSubmit(payload: DocEventPayload): Promise<void> {
    await this.setStatus(String(payload.doc.name), "Reserved");
    this.logger.log(`Stock Reservation ${payload.doc.name} reserved`);
  }

  @OnEvent("doc.on_cancel:Stock Reservation")
  async onReservationCancel(payload: DocEventPayload): Promise<void> {
    await this.setStatus(String(payload.doc.name), "Cancelled");
  }

  @OnEvent("doc.before_submit:Delivery Note", { suppressErrors: false })
  async gateDelivery(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    if (Boolean(doc.is_return)) return; // a sales return receives goods back
    for (const row of (doc.items as Array<Record<string, unknown>>) ?? []) {
      const item = String(row.item_code ?? "");
      const wh = String(row.warehouse ?? "");
      const qty = Number(row.qty ?? 0);
      if (!item || !wh || !qty) continue;
      const batch = String(row.batch_no ?? "");
      const onHand = await this.onHand(item, wh, batch);
      if (qty > onHand + 1e-9) {
        throw new BadRequestException(
          `Delivery Note ${doc.name}: cannot deliver ${qty} of ${item}${batch ? ` (batch ${batch})` : ""} from ${wh} — only ${onHand} on hand`,
        );
      }
    }
  }
}
