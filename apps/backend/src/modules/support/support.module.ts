import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { SupportListener } from "./support.listener";
import { SupportService } from "./support.service";
import { SupportController } from "./support.controller";

@Module({
  imports: [CoreModule],
  controllers: [SupportController],
  providers: [SupportListener, SupportService],
})
export class SupportModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
