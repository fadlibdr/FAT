import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { SalesteamListener } from "./salesteam.listener";

@Module({
  imports: [CoreModule],
  providers: [SalesteamListener],
})
export class SalesteamModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
