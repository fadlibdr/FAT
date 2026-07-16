import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { StockLedgerListener } from "./stock-ledger.listener";
import { StockController } from "./stock.controller";
import { PickListService } from "./pick-list.service";
import { ReservationListener } from "./reservation.listener";
import { FefoAllocationListener } from "./fefo-allocation.listener";
import { PackingService } from "./packing.service";
import { ShipmentService } from "./shipment.service";
import { DeliveryTripService } from "./delivery-trip.service";
import { WarehouseCapacityListener } from "./warehouse-capacity.listener";
import { SerialWarrantyService } from "./serial-warranty.service";

@Module({
  imports: [CoreModule],
  controllers: [StockController],
  providers: [StockLedgerListener, PickListService, ReservationListener, FefoAllocationListener, PackingService, ShipmentService, DeliveryTripService, WarehouseCapacityListener, SerialWarrantyService],
})
export class StockModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
