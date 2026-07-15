import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
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
}
