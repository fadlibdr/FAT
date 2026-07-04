import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomBytes } from "crypto";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { DoctypeLoaderService } from "../doctype/doctype-loader.service";

interface RedisLike {
  publish(channel: string, msg: string): unknown;
  subscribe(channel: string): unknown;
  on(event: string, cb: (channel: string, msg: string) => void): unknown;
  quit(): Promise<unknown>;
}

/**
 * Multi-instance metadata-cache coherence. When a DocType changes on one node,
 * its `onInvalidate` hook publishes the name on a Redis channel; every other
 * node reloads that DocType from the DB, so all in-memory registries converge
 * without a restart. No-op when REDIS_HOST is unset (single-process).
 */
@Injectable()
export class RegistrySyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistrySyncService.name);
  private readonly channel = "fat:registry:invalidate";
  private readonly instanceId = randomBytes(8).toString("hex");
  private pub: RedisLike | null = null;
  private sub: RedisLike | null = null;
  private applyingRemote = false;

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly loader: DoctypeLoaderService,
  ) {}

  onModuleInit(): void {
    if (!process.env.REDIS_HOST) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const IORedis = require("ioredis");
      const conn = { host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT ?? 6379) };
      const pub: RedisLike = new IORedis(conn);
      const sub: RedisLike = new IORedis(conn);
      this.pub = pub;
      this.sub = sub;
      sub.subscribe(this.channel);
      sub.on("message", (_ch: string, msg: string) => void this.onMessage(msg));
      this.registry.onInvalidate((name) => this.publish(name));
      this.logger.log(`Registry sync enabled (instance ${this.instanceId})`);
    } catch (err) {
      this.logger.warn(`Registry sync disabled: ${(err as Error).message}`);
      this.pub = null;
    }
  }

  private publish(name: string): void {
    if (this.applyingRemote || !this.pub) return;
    this.pub.publish(this.channel, JSON.stringify({ name, origin: this.instanceId }));
  }

  private async onMessage(msg: string): Promise<void> {
    let parsed: { name: string; origin: string };
    try {
      parsed = JSON.parse(msg);
    } catch {
      return;
    }
    if (parsed.origin === this.instanceId) return;
    this.applyingRemote = true;
    try {
      await this.loader.reloadFromDb(parsed.name);
      this.logger.log(`Reloaded DocType '${parsed.name}' from remote invalidation`);
    } catch (err) {
      this.logger.warn(`Remote reload of '${parsed.name}' failed: ${(err as Error).message}`);
    } finally {
      this.applyingRemote = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pub?.quit().catch(() => undefined);
    await this.sub?.quit().catch(() => undefined);
  }
}
