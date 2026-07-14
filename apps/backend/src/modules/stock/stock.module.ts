import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { StockLedgerListener } from "./stock-ledger.listener";
import { StockController } from "./stock.controller";
import { PickListService } from "./pick-list.service";
import { ReservationListener } from "./reservation.listener";

@Module({
  imports: [CoreModule],
  controllers: [StockController],
  providers: [StockLedgerListener, PickListService, ReservationListener],
})
export class StockModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
