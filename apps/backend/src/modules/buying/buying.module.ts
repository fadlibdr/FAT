import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { ReorderService } from "./reorder.service";
import { SourcingService } from "./sourcing.service";
import { PoFulfillmentService } from "./po-fulfillment.service";
import { PoFulfillmentListener } from "./po-fulfillment.listener";
import { BuyingController } from "./buying.controller";
import { ScorecardListener } from "./scorecard.listener";
import { ThreeWayMatchListener } from "./three-way-match.listener";

@Module({
  imports: [CoreModule],
  controllers: [BuyingController],
  providers: [ReorderService, SourcingService, PoFulfillmentService, PoFulfillmentListener, ScorecardListener, ThreeWayMatchListener],
})
export class BuyingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
