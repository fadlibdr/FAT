import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { EngagementListener } from "./engagement.listener";
import { EngagementService } from "./engagement.service";
import { EngagementController } from "./engagement.controller";

@Module({
  imports: [CoreModule],
  controllers: [EngagementController],
  providers: [EngagementListener, EngagementService],
})
export class EngagementModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
