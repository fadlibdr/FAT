import { OnModuleInit } from "@nestjs/common";
import { join } from "path";
import { DoctypeLoaderService } from "../core/doctype/doctype-loader.service";

/**
 * Base for business modules: on init, registers every `*.doctype.json` in the
 * module's own `doctypes/` directory with the engine. Subclasses just set
 * `doctypesDir` to `__dirname`.
 */
export abstract class BusinessModule implements OnModuleInit {
  protected abstract readonly baseDir: string;

  constructor(protected readonly loader: DoctypeLoaderService) {}

  async onModuleInit(): Promise<void> {
    await this.loader.registerFromDir(join(this.baseDir, "doctypes"));
  }
}
