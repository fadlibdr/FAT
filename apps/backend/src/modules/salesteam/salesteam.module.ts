import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { SalesteamListener } from "./salesteam.listener";
import { CommissionPayoutListener } from "./commission-payout.listener";
import { SalesTargetListener } from "./sales-target.listener";
import { SalesteamService } from "./salesteam.service";
import { SalesteamController } from "./salesteam.controller";

@Module({
  imports: [CoreModule],
  controllers: [SalesteamController],
  providers: [SalesteamListener, CommissionPayoutListener, SalesTargetListener, SalesteamService],
})
export class SalesteamModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
