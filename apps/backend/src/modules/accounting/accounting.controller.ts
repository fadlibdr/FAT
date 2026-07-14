import { Controller, Param, Post } from "@nestjs/common";
import { PaymentRequestService } from "./payment-request.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Accounting automation endpoints. */
@Controller("api/accounting")
export class AccountingController {
  constructor(private readonly paymentRequests: PaymentRequestService) {}

  @Post("payment-request/:name/make-payment")
  async makePayment(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const paymentEntry = await this.paymentRequests.makePayment(name, user);
    return { paymentEntry };
  }
}
