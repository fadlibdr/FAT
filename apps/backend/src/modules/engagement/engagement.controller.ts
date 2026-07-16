import { Body, Controller, ForbiddenException, Param, Post } from "@nestjs/common";
import { EngagementService } from "./engagement.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Engagement automation endpoints. */
@Controller("api/engagement")
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  @Post("run-contract-expiry")
  async runContractExpiry(@CurrentUser() user: UserContext, @Body() body: { as_of?: string }) {
    if (!user.isSuper) throw new ForbiddenException("System Manager access required");
    return this.engagement.expireContracts(body?.as_of);
  }

  @Post("contract/:name/renew")
  async renewContract(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Body() body: { days?: number },
  ) {
    return this.engagement.renewContract(name, body?.days, user);
  }
}
