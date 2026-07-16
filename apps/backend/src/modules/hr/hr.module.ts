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
import { GratuityListener } from "./gratuity.listener";
import { FinalSettlementListener } from "./final-settlement.listener";
import { OnboardingListener } from "./onboarding.listener";
import { EmployeePromotionListener } from "./employee-promotion.listener";
import { AppraisalListener } from "./appraisal.listener";
import { SeparationListener } from "./separation.listener";
import { RecruitmentService } from "./recruitment.service";
import { RecruitmentController, JobOfferController } from "./recruitment.controller";
import { LeaveEncashmentListener } from "./leave-encashment.listener";

@Module({
  imports: [CoreModule],
  controllers: [HrController, RecruitmentController, JobOfferController],
  providers: [HrService, HrListener, ExpenseClaimListener, EmployeeAdvanceListener, ShiftListener, LoanListener, LoanRepaymentListener, GratuityListener, FinalSettlementListener, OnboardingListener, EmployeePromotionListener, AppraisalListener, SeparationListener, RecruitmentService, LeaveEncashmentListener],
})
export class HrModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
