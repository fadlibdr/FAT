import { Module } from "@nestjs/common";
import { CoreModule } from "../../core/core.module";
import { DoctypeLoaderService } from "../../core/doctype/doctype-loader.service";
import { BusinessModule } from "../module-base";
import { GlPostingListener } from "./gl-posting.listener";
import { PaymentTermsListener } from "./payment-terms.listener";
import { BankReconciliationController } from "./bank-reconciliation.controller";
import { BankReconciliationService } from "./bank-reconciliation.service";

@Module({
  imports: [CoreModule],
  controllers: [BankReconciliationController],
  providers: [GlPostingListener, PaymentTermsListener, BankReconciliationService],
})
export class AccountingModule extends BusinessModule {
  protected readonly baseDir = __dirname;
  constructor(loader: DoctypeLoaderService) {
    super(loader);
  }
}
