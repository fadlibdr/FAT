import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { CrmListener } from "./crm.listener";
import { ContactListener } from "./contact.listener";

@Module({ imports: [CoreModule], providers: [CrmListener, ContactListener] })
export class CrmModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
