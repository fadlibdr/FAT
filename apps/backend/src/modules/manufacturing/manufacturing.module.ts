import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { ManufacturingListener } from "./manufacturing.listener";
import { ManufacturingService } from "./manufacturing.service";
import { JobCardService } from "./job-card.service";
import { ManufacturingController } from "./manufacturing.controller";

@Module({
  imports: [CoreModule],
  controllers: [ManufacturingController],
  providers: [ManufacturingListener, ManufacturingService, JobCardService],
})
export class ManufacturingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
