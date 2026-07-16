import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Purchase Order hold. A submitted Purchase Order can be put on hold (a supplier
 * dispute, a quality freeze, a budget review) so nothing is received or billed
 * against it until it is resumed. Enforced by a before_submit gate on Purchase
 * Receipt and Purchase Invoice. Pure SQL over sibling tables; Buying imports no
 * other module's services.
 */
@Injectable()
export class PurchaseOrderHoldService {
  private readonly logger = new Logger(PurchaseOrderHoldService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async setHold(order: string, hold: boolean, reason: string | null): Promise<void> {
    if (!this.registry.has("Purchase Order")) throw new BadRequestException("Purchase Order not registered");
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("docstatus")} AS docstatus FROM ${quoteIdent(tableNameFor("Purchase Order"))}
       WHERE ${quoteIdent("name")} = $1`,
      [order],
    );
    if (rows.length === 0) throw new BadRequestException(`Purchase Order ${order} not found`);
    if (Number(rows[0].docstatus ?? 0) !== 1) {
      throw new BadRequestException(`Purchase Order ${order} must be submitted to ${hold ? "hold" : "resume"}`);
    }
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Purchase Order"))}
       SET ${quoteIdent("on_hold")} = $1, ${quoteIdent("hold_reason")} = $2
       WHERE ${quoteIdent("name")} = $3`,
      [hold ? 1 : 0, hold ? reason : null, order],
    );
  }

  async hold(order: string, reason: string): Promise<{ order: string; on_hold: boolean }> {
    await this.setHold(order, true, String(reason ?? "").trim() || null);
    this.logger.log(`Purchase Order ${order} put on hold`);
    return { order, on_hold: true };
  }

  async resume(order: string): Promise<{ order: string; on_hold: boolean }> {
    await this.setHold(order, false, null);
    this.logger.log(`Purchase Order ${order} resumed`);
    return { order, on_hold: false };
  }

  private async isHeld(order: string): Promise<boolean> {
    if (!order || !this.registry.has("Purchase Order")) return false;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("on_hold")} AS on_hold FROM ${quoteIdent(tableNameFor("Purchase Order"))}
         WHERE ${quoteIdent("name")} = $1`,
        [order],
      )
    )[0];
    return Boolean(Number(row?.on_hold ?? 0));
  }

  // suppressErrors:false so a held-order gate aborts the submit.
  @OnEvent("doc.before_submit:Purchase Receipt", { suppressErrors: false })
  async gateReceipt(payload: DocEventPayload): Promise<void> {
    await this.gate(payload.doc, "receive");
  }

  @OnEvent("doc.before_submit:Purchase Invoice", { suppressErrors: false })
  async gateInvoice(payload: DocEventPayload): Promise<void> {
    await this.gate(payload.doc, "bill");
  }

  private async gate(doc: Record<string, unknown>, verb: string): Promise<void> {
    if (Boolean(doc.is_return)) return;
    const order = String(doc.purchase_order ?? "");
    if (order && (await this.isHeld(order))) {
      throw new BadRequestException(`Cannot ${verb} against Purchase Order ${order} — it is on hold`);
    }
  }
}
