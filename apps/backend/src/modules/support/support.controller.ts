import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { SupportService } from "./support.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Support automation endpoints. */
@Controller("api/support")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post("escalate-overdue-issues")
  async escalateOverdue(@CurrentUser() user: UserContext, @Body() body: { as_of?: string }) {
    if (!user.isSuper) throw new ForbiddenException("System Manager access required");
    return this.support.escalateOverdueIssues(body?.as_of);
  }
}
