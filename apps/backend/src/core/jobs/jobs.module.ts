import { Module } from "@nestjs/common";
import { CoreModule } from "../core.module";
import { JobService } from "./job.service";
import { RecomputeTotalsJob } from "./recompute-totals";

/**
 * Background-jobs module. Provides JobService (BullMQ-backed when REDIS_HOST is
 * set, inline otherwise) and registers the recompute-totals job.
 */
@Module({
  imports: [CoreModule],
  providers: [JobService, RecomputeTotalsJob],
  exports: [JobService],
})
export class JobsModule {}
