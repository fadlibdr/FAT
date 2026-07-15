import { Body, Controller, Param, Post } from "@nestjs/common";
import { PaymentRequestService } from "./payment-request.service";
import { PaymentService } from "./payment.service";
import { DeferredRevenueService } from "./deferred-revenue.service";
import { RecurringJournalService } from "./recurring-journal.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Accounting automation endpoints. */
@Controller("api/accounting")
export class AccountingController {
  constructor(
    private readonly paymentRequests: PaymentRequestService,
    private readonly payments: PaymentService,
    private readonly deferredRevenue: DeferredRevenueService,
    private readonly recurringJournals: RecurringJournalService,
  ) {}

  @Post("recurring-journal/run")
  async runRecurringJournals(@CurrentUser() user: UserContext, @Body() body: { as_of?: string }) {
    return this.recurringJournals.run(body?.as_of, user);
  }

  @Post("payment-request/:name/make-payment")
  async makePayment(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const paymentEntry = await this.paymentRequests.makePayment(name, user);
    return { paymentEntry };
  }

  @Post("deferred-revenue/run")
  async runDeferredRevenue(@CurrentUser() user: UserContext, @Body() body: { as_of?: string }) {
    return this.deferredRevenue.run(body?.as_of, user);
  }

  @Post("sales-invoice/:name/make-payment-entry")
  async collectSalesInvoice(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const paymentEntry = await this.payments.makePaymentEntry("Sales Invoice", name, user);
    return { paymentEntry };
  }

  @Post("purchase-invoice/:name/make-payment-entry")
  async payPurchaseInvoice(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const paymentEntry = await this.payments.makePaymentEntry("Purchase Invoice", name, user);
    return { paymentEntry };
  }
}
