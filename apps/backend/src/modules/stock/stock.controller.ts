import { Controller, Param, Post } from "@nestjs/common";
import { PickListService } from "./pick-list.service";
import { PackingService } from "./packing.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Stock automation endpoints. */
@Controller("api/stock")
export class StockController {
  constructor(
    private readonly pickList: PickListService,
    private readonly packing: PackingService,
  ) {}

  @Post("delivery-note/:name/make-packing-slip")
  async dnToPackingSlip(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const packingSlip = await this.packing.makeFromDeliveryNote(name, user);
    return { packingSlip };
  }

  @Post("pick-list/:name/make-delivery-note")
  async pickToDelivery(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const deliveryNote = await this.pickList.makeDeliveryNote(name, user);
    return { deliveryNote };
  }

  @Post("sales-order/:name/make-pick-list")
  async soToPickList(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const pickList = await this.pickList.makeFromSalesOrder(name, user);
    return { pickList };
  }
}
