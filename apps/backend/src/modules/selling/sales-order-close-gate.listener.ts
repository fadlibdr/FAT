import { BadRequestException, Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Closed Sales Order enforcement. A short-closed order has written off its
 * remaining balance, so nothing more may ship or bill against it. Enforced by a
 * before_submit gate on Delivery Note and Sales Invoice — a return is exempt.
 * Pure SQL over sibling tables; Selling imports no other module's services.
 */
@Injectable()
export class SalesOrderCloseGateListener {
  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  // suppressErrors:false so a closed-order gate aborts the submit.
  @OnEvent("doc.before_submit:Delivery Note", { suppressErrors: false })
  async gateDelivery(payload: DocEventPayload): Promise<void> {
    await this.gate(payload.doc, "deliver");
  }

  @OnEvent("doc.before_submit:Sales Invoice", { suppressErrors: false })
  async gateInvoice(payload: DocEventPayload): Promise<void> {
    await this.gate(payload.doc, "bill");
  }

  private async gate(doc: Record<string, unknown>, verb: string): Promise<void> {
    if (Boolean(doc.is_return)) return;
    const order = String(doc.sales_order ?? "");
    if (order && (await this.isClosed(order))) {
      throw new BadRequestException(`Cannot ${verb} against Sales Order ${order} — it is closed`);
    }
  }

  private async isClosed(order: string): Promise<boolean> {
    if (!order || !this.registry.has("Sales Order")) return false;
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("is_closed")} AS is_closed FROM ${quoteIdent(tableNameFor("Sales Order"))}
         WHERE ${quoteIdent("name")} = $1`,
        [order],
      )
    )[0];
    return Boolean(Number(row?.is_closed ?? 0));
  }
}
