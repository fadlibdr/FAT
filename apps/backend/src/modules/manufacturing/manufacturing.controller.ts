import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ManufacturingService } from "./manufacturing.service";
import { JobCardService } from "./job-card.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Manufacturing automation endpoints. */
@Controller("api/manufacturing")
export class ManufacturingController {
  constructor(
    private readonly manufacturing: ManufacturingService,
    private readonly jobCards: JobCardService,
  ) {}

  @Post("sales-order/:name/make-work-orders")
  async makeWorkOrders(@CurrentUser() user: UserContext, @Param("name") name: string) {
    return this.manufacturing.makeWorkOrders(name, user);
  }

  @Get("item/:code/where-used")
  async whereUsed(@Param("code") code: string) {
    return this.manufacturing.whereUsed(code);
  }

  @Post("job-card/:name/start")
  async startJobCard(@Param("name") name: string) {
    return this.jobCards.start(name);
  }

  @Post("job-card/:name/complete")
  async completeJobCard(@Param("name") name: string, @Body() body: { actual_time_in_mins?: number }) {
    return this.jobCards.complete(name, body?.actual_time_in_mins);
  }

  @Post("work-order/:name/finish")
  async finishWorkOrder(@Param("name") name: string) {
    return this.jobCards.finishWorkOrder(name);
  }
}
