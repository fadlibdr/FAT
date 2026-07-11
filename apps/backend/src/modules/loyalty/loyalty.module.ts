import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { LoyaltyListener } from "./loyalty.listener";
import { LoyaltyController } from "./loyalty.controller";

@Module({
  imports: [CoreModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyListener],
})
export class LoyaltyModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
