import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { CrmListener } from "./crm.listener";
import { ContactListener } from "./contact.listener";
import { CrmService } from "./crm.service";
import { CrmController } from "./crm.controller";

@Module({
  imports: [CoreModule],
  controllers: [CrmController],
  providers: [CrmListener, ContactListener, CrmService],
})
export class CrmModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
