import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { FulfillmentService } from "./fulfillment.service";
import { VariantService } from "./variant.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Selling endpoints: Sales-Order → Delivery/Invoice conversions, and Item
 * variant generation / resolution.
 */
@Controller("api/selling")
export class SellingController {
  constructor(
    private readonly fulfillment: FulfillmentService,
    private readonly variants: VariantService,
  ) {}

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

  @Post("quotation/:name/make-sales-order")
  async makeSalesOrder(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const salesOrder = await this.fulfillment.makeSalesOrder(name, user);
    return { salesOrder };
  }

  @Post("item/:template/make-variants")
  async makeVariants(@CurrentUser() user: UserContext, @Param("template") template: string) {
    return this.variants.makeVariants(template, user);
  }

  @Get("item/:template/variant")
  async resolveVariant(@Param("template") template: string, @Query() query: Record<string, string>) {
    const variant = await this.variants.resolve(template, query);
    return { template, variant };
  }
}
