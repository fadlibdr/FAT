import { Body, Controller, ForbiddenException, Param, Post } from "@nestjs/common";
import { SubscriptionService } from "./subscription.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * On-demand trigger for the recurring-billing run (System Manager only), used
 * for verification and manual catch-up. An optional `as_of` date bills every
 * subscription due on or before it.
 */
@Controller("api/admin/run-subscriptions")
export class SubscriptionController {
  constructor(private readonly subscriptions: SubscriptionService) {}

  @Post()
  async run(@CurrentUser() user: UserContext, @Body() body: { as_of?: string }) {
    if (!user.isSuper) throw new ForbiddenException("System Manager access required");
    const generated = await this.subscriptions.generateDueInvoices(body?.as_of);
    return { generated };
  }

  @Post("cancel/:name")
  async cancel(@CurrentUser() user: UserContext, @Param("name") name: string) {
    if (!user.isSuper) throw new ForbiddenException("System Manager access required");
    return this.subscriptions.cancel(name);
  }
}
