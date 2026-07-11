import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { ReorderService } from "./reorder.service";
import { BuyingController } from "./buying.controller";

@Module({
  imports: [CoreModule],
  controllers: [BuyingController],
  providers: [ReorderService],
})
export class BuyingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
