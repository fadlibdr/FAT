import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { GlPostingListener } from "./gl-posting.listener";
import { PaymentAllocationListener } from "./payment-allocation.listener";
import { PaymentTermsListener } from "./payment-terms.listener";
import { JournalListener } from "./journal.listener";
import { BankReconciliationController } from "./bank-reconciliation.controller";
import { BankReconciliationService } from "./bank-reconciliation.service";
import { AccountingController } from "./accounting.controller";
import { PaymentRequestService } from "./payment-request.service";
import { PaymentService } from "./payment.service";
import { JournalService } from "./journal.service";
import { DeferredRevenueListener } from "./deferred-revenue.listener";
import { DeferredRevenueService } from "./deferred-revenue.service";
import { RecurringJournalService } from "./recurring-journal.service";
import { ExchangeRevaluationListener } from "./exchange-revaluation.listener";
import { InventoryGlListener } from "./inventory-gl.listener";
import { BudgetGateListener } from "./budget-gate.listener";
import { PeriodLockListener } from "./period-lock.listener";
import { WriteOffListener } from "./write-off.listener";
import { TaxTemplateListener } from "./tax-template.listener";
import { ContraEntryListener } from "./contra-entry.listener";

@Module({
  imports: [CoreModule],
  controllers: [BankReconciliationController, AccountingController],
  providers: [
    GlPostingListener,
    PaymentAllocationListener,
    PaymentTermsListener,
    JournalListener,
    BankReconciliationService,
    PaymentRequestService,
    PaymentService,
    JournalService,
    DeferredRevenueListener,
    DeferredRevenueService,
    RecurringJournalService,
    ExchangeRevaluationListener,
    InventoryGlListener,
    BudgetGateListener,
    PeriodLockListener,
    WriteOffListener,
    TaxTemplateListener,
    ContraEntryListener,
  ],
})
export class AccountingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
