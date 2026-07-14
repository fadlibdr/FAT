import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { GlPostingListener } from "./gl-posting.listener";
import { PaymentTermsListener } from "./payment-terms.listener";
import { JournalListener } from "./journal.listener";
import { BankReconciliationController } from "./bank-reconciliation.controller";
import { BankReconciliationService } from "./bank-reconciliation.service";
import { AccountingController } from "./accounting.controller";
import { PaymentRequestService } from "./payment-request.service";
import { DeferredRevenueListener } from "./deferred-revenue.listener";
import { DeferredRevenueService } from "./deferred-revenue.service";

@Module({
  imports: [CoreModule],
  controllers: [BankReconciliationController, AccountingController],
  providers: [
    GlPostingListener,
    PaymentTermsListener,
    JournalListener,
    BankReconciliationService,
    PaymentRequestService,
    DeferredRevenueListener,
    DeferredRevenueService,
  ],
})
export class AccountingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
