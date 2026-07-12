import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { PricingRuleListener } from "./pricing-rule.listener";
import { FulfillmentService } from "./fulfillment.service";
import { FulfillmentListener } from "./fulfillment.listener";
import { SellingController } from "./selling.controller";

@Module({
  imports: [CoreModule],
  controllers: [SellingController],
  providers: [PricingRuleListener, FulfillmentService, FulfillmentListener],
})
export class SellingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
