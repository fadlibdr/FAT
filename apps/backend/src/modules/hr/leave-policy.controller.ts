import { Body, Controller, Param, Post } from "@nestjs/common";
import { LeavePolicyService } from "./leave-policy.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Leave Policy assignment endpoint. */
@Controller("api/hr/leave-policy")
export class LeavePolicyController {
  constructor(private readonly leavePolicy: LeavePolicyService) {}

  @Post(":name/assign")
  assign(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Body() body: { employee: string; from_date: string; to_date: string },
  ) {
    return this.leavePolicy.assign(name, body?.employee, body?.from_date, body?.to_date, user);
  }
}
