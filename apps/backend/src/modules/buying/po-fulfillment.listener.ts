import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { PoFulfillmentService } from "./po-fulfillment.service";

/**
 * Keeps a Purchase Order's received/billed status current: recomputes on order
 * submit, and whenever a Purchase Receipt or Purchase Invoice referencing it is
 * submitted or cancelled.
 */
@Injectable()
export class PoFulfillmentListener {
  constructor(private readonly fulfillment: PoFulfillmentService) {}

  @OnEvent("doc.on_submit:Purchase Order")
  async onOrder(payload: DocEventPayload): Promise<void> {
    await this.fulfillment.recomputePurchaseOrder(String(payload.doc.name));
    // A drop-ship order fulfils its linked Sales Order — the supplier ships direct.
    if (Boolean(payload.doc.is_drop_ship) && payload.doc.sales_order) {
      await this.fulfillment.markDropShipDelivery(String(payload.doc.sales_order));
    }
  }

  @OnEvent("doc.on_submit:Purchase Receipt")
  @OnEvent("doc.on_cancel:Purchase Receipt")
  @OnEvent("doc.on_submit:Purchase Invoice")
  @OnEvent("doc.on_cancel:Purchase Invoice")
  async onLinked(payload: DocEventPayload): Promise<void> {
    const po = payload.doc.purchase_order;
    if (po) await this.fulfillment.recomputePurchaseOrder(String(po));
  }
}
