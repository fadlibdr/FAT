import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { PricingRuleListener } from "./pricing-rule.listener";

@Module({ imports: [CoreModule], providers: [PricingRuleListener] })
export class SellingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
