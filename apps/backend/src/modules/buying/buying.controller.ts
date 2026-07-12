import { Body, Controller, ForbiddenException, Get, Param, Post } from "@nestjs/common";
import { ReorderService } from "./reorder.service";
import { SourcingService } from "./sourcing.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Buying automation endpoints: reorder runs, Material-Request / Supplier-Quotation
 * conversion to Purchase Orders, and RFQ quote comparison. Reorder is
 * System-Manager only (it writes across items); the rest is allowed for anyone
 * who can create a Purchase Order.
 */
@Controller("api/buying")
export class BuyingController {
  constructor(
    private readonly reorder: ReorderService,
    private readonly sourcing: SourcingService,
  ) {}

  @Post("run-reorder")
  async runReorder(@CurrentUser() user: UserContext, @Body() body: { as_of?: string }) {
    if (!user.isSuper) throw new ForbiddenException("System Manager access required");
    const materialRequest = await this.reorder.raiseReorderRequests(body?.as_of);
    return { materialRequest };
  }

  @Post("material-request/:name/make-purchase-order")
  async makePurchaseOrder(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Body() body: { supplier: string },
  ) {
    const purchaseOrder = await this.reorder.makePurchaseOrder(name, body?.supplier, user);
    return { purchaseOrder };
  }

  @Get("rfq-comparison/:name")
  async rfqComparison(@Param("name") name: string) {
    return { rfq: name, comparison: await this.sourcing.compare(name) };
  }

  @Post("supplier-quotation/:name/make-purchase-order")
  async sqToPurchaseOrder(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const purchaseOrder = await this.sourcing.makePurchaseOrder(name, user);
    return { purchaseOrder };
  }
}
