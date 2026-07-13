import { Controller, Param, Post } from "@nestjs/common";
import { PickListService } from "./pick-list.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Stock automation endpoints. */
@Controller("api/stock")
export class StockController {
  constructor(private readonly pickList: PickListService) {}

  @Post("pick-list/:name/make-delivery-note")
  async pickToDelivery(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const deliveryNote = await this.pickList.makeDeliveryNote(name, user);
    return { deliveryNote };
  }
}
