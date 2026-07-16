import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { QualityListener } from "./quality.listener";
import { NonConformanceListener } from "./non-conformance.listener";

@Module({
  imports: [CoreModule],
  providers: [QualityListener, NonConformanceListener],
})
export class QualityModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
