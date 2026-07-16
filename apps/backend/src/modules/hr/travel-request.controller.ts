import { Controller, Param, Post } from "@nestjs/common";
import { TravelRequestService } from "./travel-request.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Travel Request approval + expense-claim actions. */
@Controller("api/hr/travel-request")
export class TravelRequestController {
  constructor(private readonly travel: TravelRequestService) {}

  @Post(":name/approve")
  approve(@Param("name") name: string) {
    return this.travel.approve(name);
  }

  @Post(":name/reject")
  reject(@Param("name") name: string) {
    return this.travel.reject(name);
  }

  @Post(":name/make-expense-claim")
  makeExpenseClaim(@CurrentUser() user: UserContext, @Param("name") name: string) {
    return this.travel.makeExpenseClaim(name, user);
  }
}
