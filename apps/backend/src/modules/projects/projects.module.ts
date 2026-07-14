import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { ProjectsListener } from "./projects.listener";
import { TaskListener } from "./task.listener";

@Module({
  imports: [CoreModule],
  providers: [ProjectsListener, TaskListener],
})
export class ProjectsModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
