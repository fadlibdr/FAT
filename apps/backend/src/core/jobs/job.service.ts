import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

/**
 * Lightweight background-job abstraction.
 *
 * - If `REDIS_HOST` is set, jobs are enqueued to a BullMQ queue and processed by
 *   a worker (true background processing across the pool).
 * - Otherwise, jobs run inline (awaited) so the app is fully functional without
 *   Redis. The calling code is identical either way — only the env differs.
 *
 * BullMQ is imported lazily so the dependency is only loaded when enabled.
 */
@Injectable()
export class JobService implements OnModuleDestroy {
  private readonly logger = new Logger(JobService.name);
  private readonly handlers = new Map<string, JobHandler>();
  // Typed as unknown to avoid importing bullmq types when disabled.
  private queue: { add: (name: string, data: unknown) => Promise<unknown> } | null = null;
  private worker: { close: () => Promise<void> } | null = null;
  private readonly enabled = !!process.env.REDIS_HOST;

  constructor() {
    if (this.enabled) this.initQueue();
  }

  private initQueue(): void {
    try {
      // Lazy require so bullmq/ioredis are only needed when REDIS_HOST is set.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Queue, Worker } = require("bullmq");
      const connection = {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT ?? 6379),
      };
      this.queue = new Queue("fat-jobs", { connection });
      this.worker = new Worker(
        "fat-jobs",
        async (job: { name: string; data: Record<string, unknown> }) => {
          await this.run(job.name, job.data);
        },
        { connection },
      );
      this.logger.log(`Background queue enabled (redis ${connection.host}:${connection.port})`);
    } catch (err) {
      this.logger.warn(
        `Queue init failed, falling back to inline jobs: ${(err as Error).message}`,
      );
      this.queue = null;
    }
  }

  /** Register a named job handler. */
  register(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  /** Enqueue a job (background if Redis is enabled, else run inline). */
  async enqueue(name: string, payload: Record<string, unknown>): Promise<void> {
    if (this.queue) {
      await this.queue.add(name, payload);
    } else {
      await this.run(name, payload);
    }
  }

  private async run(name: string, payload: Record<string, unknown>): Promise<void> {
    const handler = this.handlers.get(name);
    if (!handler) {
      this.logger.warn(`No handler for job '${name}'`);
      return;
    }
    try {
      await handler(payload);
    } catch (err) {
      this.logger.error(`Job '${name}' failed: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) await this.worker.close();
  }
}
