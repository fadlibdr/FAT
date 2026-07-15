import { Body, Controller, Param, Post } from "@nestjs/common";
import { SalesteamService } from "./salesteam.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Sales-team / agreement endpoints. */
@Controller("api/salesteam")
export class SalesteamController {
  constructor(private readonly salesteam: SalesteamService) {}

  @Post("blanket-order/:name/make-sales-order")
  async makeSalesOrder(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Body() body: { qty?: number },
  ) {
    const salesOrder = await this.salesteam.makeSalesOrder(name, body?.qty, user);
    return { salesOrder };
  }
}
