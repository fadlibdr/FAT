import { Controller, Get, Param, Query } from "@nestjs/common";
import { HrService } from "./hr.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * HR read endpoints. Leave balance is derived live from submitted allocations
 * and applications; an optional `leave_type` query narrows it to one type.
 */
@Controller("api/hr")
export class HrController {
  constructor(private readonly hr: HrService) {}

  @Get("leave-balance/:employee")
  async leaveBalance(
    @CurrentUser() _user: UserContext,
    @Param("employee") employee: string,
    @Query("leave_type") leaveType?: string,
  ) {
    if (leaveType) {
      return { employee, leave_type: leaveType, balance: await this.hr.balanceFor(employee, leaveType) };
    }
    return { employee, balances: await this.hr.balances(employee) };
  }
}
