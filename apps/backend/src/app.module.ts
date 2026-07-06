import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ScheduleModule } from "@nestjs/schedule";
import { ThrottlerModule } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import { buildDataSourceOptions } from "./data-source";
import { CoreModule } from "./core/core.module";
import { JobsModule } from "./core/jobs/jobs.module";
import { FatGraphQLModule } from "./graphql/graphql.module";
import { GqlThrottlerGuard } from "./graphql/gql-throttler.guard";
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
import { ManufacturingModule } from "./modules/manufacturing/manufacturing.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { AssetsModule } from "./modules/assets/assets.module";

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      { ttl: 60_000, limit: Number(process.env.RATE_LIMIT ?? 120) },
    ]),
    TypeOrmModule.forRoot(buildDataSourceOptions()),
    CoreModule,
    JobsModule,
    FatGraphQLModule,
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
    ManufacturingModule,
    ProjectsModule,
    AssetsModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: GqlThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
