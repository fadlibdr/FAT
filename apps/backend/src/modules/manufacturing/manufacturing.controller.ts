import { Controller, Param, Post } from "@nestjs/common";
import { ManufacturingService } from "./manufacturing.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Manufacturing automation endpoints. */
@Controller("api/manufacturing")
export class ManufacturingController {
  constructor(private readonly manufacturing: ManufacturingService) {}

  @Post("sales-order/:name/make-work-orders")
  async makeWorkOrders(@CurrentUser() user: UserContext, @Param("name") name: string) {
    return this.manufacturing.makeWorkOrders(name, user);
  }
}
