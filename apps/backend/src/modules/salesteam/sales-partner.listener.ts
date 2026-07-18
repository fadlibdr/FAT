import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Sales Partner commission. A Sales Partner is an external referrer that earns a
 * percentage on the orders it brings in. When a Sales Order that names a partner
 * is submitted, the partner's sourced order value and accrued commission
 * (grand_total × rate) grow; cancelling the order unwinds both. Pure event-bus
 * listener — Salesteam imports no other module's services.
 */
@Injectable()
export class SalesPartnerListener {
  private readonly logger = new Logger(SalesPartnerListener.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so an out-of-range rate aborts the save.
  @OnEvent("doc.before_save:Sales Partner", { suppressErrors: false })
  gateRate(payload: BeforeSavePayload): void {
    const rate = Number(payload.data.commission_rate ?? 0);
    if (rate < 0 || rate > 100) {
      throw new BadRequestException("Commission Rate must be between 0 and 100");
    }
  }

  @OnEvent("doc.on_submit:Sales Order")
  async onOrderSubmit(payload: DocEventPayload): Promise<void> {
    await this.accrue(payload.doc, 1);
  }

  @OnEvent("doc.on_cancel:Sales Order")
  async onOrderCancel(payload: DocEventPayload): Promise<void> {
    await this.accrue(payload.doc, -1);
  }

  /** Add (sign +1) or reverse (sign -1) an order's value and commission on its partner. */
  private async accrue(order: Record<string, unknown>, sign: number): Promise<void> {
    const partner = String(order.sales_partner ?? "");
    if (!partner || !this.registry.has("Sales Partner")) return;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("commission_rate")} AS rate FROM ${quoteIdent(tableNameFor("Sales Partner"))}
         WHERE ${quoteIdent("name")} = $1`,
        [partner],
      )
    )[0];
    if (!row) return;
    // Read the persisted grand_total: the selling module computes it on save, and
    // the value on the in-memory doc is not reliably populated at submit time.
    const soRow = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("grand_total")} AS gt FROM ${quoteIdent(tableNameFor("Sales Order"))}
         WHERE ${quoteIdent("name")} = $1`,
        [String(order.name ?? "")],
      )
    )[0];
    const orderValue = Number(soRow?.gt ?? order.grand_total ?? 0);
    const commission = round2((orderValue * Number(row.rate ?? 0)) / 100);
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Sales Partner"))}
       SET ${quoteIdent("total_orders")} = coalesce(${quoteIdent("total_orders")}, 0) + $1,
           ${quoteIdent("total_commission")} = coalesce(${quoteIdent("total_commission")}, 0) + $2
       WHERE ${quoteIdent("name")} = $3`,
      [sign * orderValue, sign * commission, partner],
    );
    this.logger.log(
      `Sales Partner ${partner}: ${sign > 0 ? "+" : "-"}order ${orderValue}, ${sign > 0 ? "+" : "-"}commission ${commission}`,
    );
  }
}
