import { Body, Controller, ForbiddenException, Param, Post } from "@nestjs/common";
import { ReorderService } from "./reorder.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Buying automation endpoints: trigger the reorder run on demand and convert a
 * Material Request into a Purchase Order. Reorder is System-Manager only (it
 * writes across items); MR->PO is allowed for anyone who can create a PO.
 */
@Controller("api/buying")
export class BuyingController {
  constructor(private readonly reorder: ReorderService) {}

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
}
