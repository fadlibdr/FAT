import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { HrService } from "./hr.service";
import { HrListener } from "./hr.listener";
import { HrController } from "./hr.controller";
import { ExpenseClaimListener } from "./expense-claim.listener";
import { EmployeeAdvanceListener } from "./employee-advance.listener";
import { ShiftListener } from "./shift.listener";
import { LoanListener } from "./loan.listener";
import { LoanRepaymentListener } from "./loan-repayment.listener";

@Module({
  imports: [CoreModule],
  controllers: [HrController],
  providers: [HrService, HrListener, ExpenseClaimListener, EmployeeAdvanceListener, ShiftListener, LoanListener, LoanRepaymentListener],
})
export class HrModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
