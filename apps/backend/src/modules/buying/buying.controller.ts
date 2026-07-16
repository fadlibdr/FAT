import { Body, Controller, ForbiddenException, Get, Param, Post } from "@nestjs/common";
import { ReorderService } from "./reorder.service";
import { SourcingService } from "./sourcing.service";
import { PoFulfillmentService } from "./po-fulfillment.service";
import { PurchaseOrderHoldService } from "./purchase-order-hold.service";
import { SubcontractingService } from "./subcontracting.service";
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
    private readonly poFulfillment: PoFulfillmentService,
    private readonly holds: PurchaseOrderHoldService,
    private readonly subcontracting: SubcontractingService,
  ) {}

  @Post("subcontracting-order/:name/make-receipt")
  async makeSubcontractingReceipt(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const subcontractingReceipt = await this.subcontracting.makeSubcontractingReceipt(name, user);
    return { subcontractingReceipt };
  }

  @Post("purchase-order/:name/hold")
  async holdOrder(@Param("name") name: string, @Body() body: { reason?: string }) {
    return this.holds.hold(name, body?.reason ?? "");
  }

  @Post("purchase-order/:name/resume")
  async resumeOrder(@Param("name") name: string) {
    return this.holds.resume(name);
  }

  @Post("purchase-order/:name/close")
  async closeOrder(@Param("name") name: string) {
    return this.poFulfillment.closePurchaseOrder(name);
  }

  @Post("purchase-order/:name/reopen")
  async reopenOrder(@Param("name") name: string) {
    return this.poFulfillment.reopenPurchaseOrder(name);
  }

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

  @Post("material-request/:name/make-rfq")
  async mrToRfq(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Body() body: { suppliers?: string[] },
  ) {
    const requestForQuotation = await this.sourcing.makeRequestForQuotation(name, body?.suppliers ?? [], user);
    return { requestForQuotation };
  }

  @Post("sales-order/:name/make-drop-ship-po")
  async soToDropShipPo(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const purchaseOrders = await this.sourcing.makeDropShipPurchaseOrders(name, user);
    return { purchaseOrders };
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

  @Post("purchase-order/:name/make-purchase-receipt")
  async poToReceipt(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const purchaseReceipt = await this.poFulfillment.makeFromPurchaseOrder(name, "Purchase Receipt", user);
    return { purchaseReceipt };
  }

  @Post("purchase-order/:name/make-purchase-invoice")
  async poToInvoice(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const purchaseInvoice = await this.poFulfillment.makeFromPurchaseOrder(name, "Purchase Invoice", user);
    return { purchaseInvoice };
  }

  @Post("purchase-receipt/:name/make-purchase-invoice")
  async receiptToInvoice(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const purchaseInvoice = await this.poFulfillment.makePurchaseInvoiceFromReceipt(name, user);
    return { purchaseInvoice };
  }

  @Post("purchase-invoice/:name/make-return")
  async makePurchaseReturn(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const debitNote = await this.poFulfillment.makePurchaseReturn(name, user);
    return { debitNote };
  }

  @Post("purchase-receipt/:name/make-return")
  async makeReceiptReturn(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const returnReceipt = await this.poFulfillment.makeReceiptReturn(name, user);
    return { returnReceipt };
  }
}
