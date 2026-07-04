import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { TypeOrmModule } from "@nestjs/typeorm";
import { buildDataSourceOptions } from "./data-source";
import { CoreModule } from "./core/core.module";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { HealthController } from "./health.controller";
import { CoreDomainModule } from "./modules/core-domain/core-domain.module";
import { CrmModule } from "./modules/crm/crm.module";
import { SellingModule } from "./modules/selling/selling.module";
import { BuyingModule } from "./modules/buying/buying.module";
import { StockModule } from "./modules/stock/stock.module";
import { AccountingModule } from "./modules/accounting/accounting.module";
import { HrModule } from "./modules/hr/hr.module";

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRoot(buildDataSourceOptions()),
    CoreModule,
    AuthModule,
    // Order matters for readable startup logs; Link validation is runtime, not
    // load-time, so masters need not strictly precede dependents.
    CoreDomainModule,
    CrmModule,
    SellingModule,
    BuyingModule,
    StockModule,
    AccountingModule,
    HrModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
