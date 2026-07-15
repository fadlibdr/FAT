import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { LoyaltyListener } from "./loyalty.listener";
import { LoyaltyController, LoyaltyRedeemController } from "./loyalty.controller";
import { LoyaltyService } from "./loyalty.service";

@Module({
  imports: [CoreModule],
  controllers: [LoyaltyController, LoyaltyRedeemController],
  providers: [LoyaltyListener, LoyaltyService],
})
export class LoyaltyModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
