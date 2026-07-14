import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { AssetsListener } from "./assets.listener";
import { AssetsController } from "./assets.controller";
import { AssetDepreciationService } from "./asset-depreciation.service";

@Module({
  imports: [CoreModule],
  controllers: [AssetsController],
  providers: [AssetsListener, AssetDepreciationService],
})
export class AssetsModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
