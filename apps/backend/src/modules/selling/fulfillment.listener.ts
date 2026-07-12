import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { FulfillmentService } from "./fulfillment.service";

/**
 * Keeps a Sales Order's delivered/billed status current. Recomputes when the
 * order is submitted (sets the initial "To Deliver and Bill"), and whenever a
 * Delivery Note or Sales Invoice that references it is submitted or cancelled.
 */
@Injectable()
export class FulfillmentListener {
  constructor(private readonly fulfillment: FulfillmentService) {}

  @OnEvent("doc.on_submit:Sales Order")
  async onOrder(payload: DocEventPayload): Promise<void> {
    await this.fulfillment.recomputeSalesOrder(String(payload.doc.name));
  }

  @OnEvent("doc.on_submit:Delivery Note")
  @OnEvent("doc.on_cancel:Delivery Note")
  @OnEvent("doc.on_submit:Sales Invoice")
  @OnEvent("doc.on_cancel:Sales Invoice")
  async onLinked(payload: DocEventPayload): Promise<void> {
    const so = payload.doc.sales_order;
    if (so) await this.fulfillment.recomputeSalesOrder(String(so));
  }
}
