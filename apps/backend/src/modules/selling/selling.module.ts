import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { ItemPriceListener } from "./item-price.listener";
import { PricingRuleListener } from "./pricing-rule.listener";
import { FulfillmentService } from "./fulfillment.service";
import { FulfillmentListener } from "./fulfillment.listener";
import { VariantService } from "./variant.service";
import { VariantListener } from "./variant.listener";
import { PromotionListener } from "./promotion.listener";
import { SoFulfillmentGateListener } from "./so-fulfillment-gate.listener";
import { SellingController } from "./selling.controller";

@Module({
  imports: [CoreModule],
  controllers: [SellingController],
  providers: [
    ItemPriceListener,
    PricingRuleListener,
    FulfillmentService,
    FulfillmentListener,
    VariantService,
    VariantListener,
    PromotionListener,
    SoFulfillmentGateListener,
  ],
})
export class SellingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
