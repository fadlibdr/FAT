import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { MaintenanceListener } from "./maintenance.listener";
import { MaintenanceService } from "./maintenance.service";
import { MaintenanceController } from "./maintenance.controller";

@Module({
  imports: [CoreModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceListener, MaintenanceService],
})
export class MaintenanceModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
