import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { PayrollListener } from "./payroll.listener";
import { PayrollEntryListener } from "./payroll-entry.listener";
import { SalaryAssignmentListener } from "./salary-assignment.listener";

@Module({
  imports: [CoreModule],
  providers: [PayrollListener, PayrollEntryListener, SalaryAssignmentListener],
})
export class PayrollModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
