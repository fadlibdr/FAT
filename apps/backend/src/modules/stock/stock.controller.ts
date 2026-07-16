import { Body, Controller, Param, Post } from "@nestjs/common";
import { PickListService } from "./pick-list.service";
import { PackingService } from "./packing.service";
import { ShipmentService } from "./shipment.service";
import { DeliveryTripService } from "./delivery-trip.service";
import { SerialWarrantyService } from "./serial-warranty.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/** Stock automation endpoints. */
@Controller("api/stock")
export class StockController {
  constructor(
    private readonly pickList: PickListService,
    private readonly packing: PackingService,
    private readonly shipment: ShipmentService,
    private readonly deliveryTrip: DeliveryTripService,
    private readonly serialWarranty: SerialWarrantyService,
  ) {}

  @Post("run-serial-warranty")
  async runSerialWarranty(@Body() body: { as_of?: string }) {
    const updated = await this.serialWarranty.recompute(body?.as_of);
    return { updated };
  }

  @Post("make-delivery-trip")
  async makeDeliveryTrip(
    @CurrentUser() user: UserContext,
    @Body() body: { delivery_notes?: string[]; driver?: string; vehicle?: string },
  ) {
    const deliveryTrip = await this.deliveryTrip.makeFromDeliveryNotes(
      body?.delivery_notes ?? [],
      body?.driver ?? "",
      body?.vehicle ?? "",
      user,
    );
    return { deliveryTrip };
  }

  @Post("delivery-trip/:name/dispatch")
  async dispatchTrip(@Param("name") name: string) {
    return this.deliveryTrip.dispatch(name);
  }

  @Post("delivery-trip/:name/complete")
  async completeTrip(@Param("name") name: string) {
    return this.deliveryTrip.complete(name);
  }

  @Post("delivery-note/:name/make-packing-slip")
  async dnToPackingSlip(@CurrentUser() user: UserContext, @Param("name") name: string) {
    const packingSlip = await this.packing.makeFromDeliveryNote(name, user);
    return { packingSlip };
  }

  @Post("make-shipment")
  async makeShipment(
    @CurrentUser() user: UserContext,
    @Body() body: { delivery_notes?: string[]; carrier?: string; awb_number?: string },
  ) {
    const shipment = await this.shipment.makeFromDeliveryNotes(
      body?.delivery_notes ?? [],
      body?.carrier ?? "",
      body?.awb_number ?? "",
      user,
    );
    return { shipment };
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

  @Post("pick-list/:name/confirm-picking")
  async confirmPicking(
    @CurrentUser() user: UserContext,
    @Param("name") name: string,
    @Body() body: { picks?: Record<string, number> },
  ) {
    return this.pickList.confirmPicking(name, body?.picks, user);
  }
}
