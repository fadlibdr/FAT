import { Controller, Param, Post } from "@nestjs/common";
import { FulfillmentService } from "./fulfillment.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Selling conversions: create a draft Delivery Note or Sales Invoice pre-filled
 * from a submitted Sales Order and linked back to it (which drives the order's
 * delivered/billed status once the draft is itself submitted).
 */
@Controller("api/selling")
export class SellingController {
  constructor(private readonly fulfillment: FulfillmentService) {}

  @Post("sales-order/:name/make-delivery-note")
  async makeDeliveryNote(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const deliveryNote = await this.fulfillment.makeFromSalesOrder(name, "Delivery Note", user);
    return { deliveryNote };
  }

  @Post("sales-order/:name/make-sales-invoice")
  async makeSalesInvoice(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const salesInvoice = await this.fulfillment.makeFromSalesOrder(name, "Sales Invoice", user);
    return { salesInvoice };
  }
}
