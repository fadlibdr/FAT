import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../doctype/schema-sync.service";
import type { DocEvent, DocEventPayload } from "../doctype/hooks.service";

/**
 * Fires user-configured Webhooks: on any document event it looks up enabled
 * Webhook records matching the doctype+event and POSTs the document JSON to the
 * target URL. Best-effort — failures are logged, never block the transaction.
 */
@Injectable()
export class WebhookListener {
  private readonly logger = new Logger(WebhookListener.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: DoctypeRegistryService,
  ) {}

  @OnEvent("doc.after_insert")
  afterInsert(p: DocEventPayload) {
    void this.dispatch("after_insert", p);
  }
  @OnEvent("doc.after_update")
  afterUpdate(p: DocEventPayload) {
    void this.dispatch("after_update", p);
  }
  @OnEvent("doc.after_delete")
  afterDelete(p: DocEventPayload) {
    void this.dispatch("after_delete", p);
  }
  @OnEvent("doc.on_submit")
  onSubmit(p: DocEventPayload) {
    void this.dispatch("on_submit", p);
  }
  @OnEvent("doc.on_cancel")
  onCancel(p: DocEventPayload) {
    void this.dispatch("on_cancel", p);
  }

  private async dispatch(event: DocEvent, payload: DocEventPayload): Promise<void> {
    if (!this.registry.has("Webhook")) return;
    if (payload.doctype === "Webhook") return;
    let hooks: Array<{ request_url: string }>;
    try {
      hooks = await this.dataSource.query(
        `SELECT ${quoteIdent("request_url")} AS request_url FROM ${quoteIdent(tableNameFor("Webhook"))}
         WHERE ${quoteIdent("webhook_doctype")} = $1 AND ${quoteIdent("webhook_event")} = $2
           AND ${quoteIdent("enabled")} = 1`,
        [payload.doctype, event],
      );
    } catch {
      return;
    }
    for (const h of hooks) {
      try {
        await fetch(h.request_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ event, doctype: payload.doctype, doc: payload.doc }),
        });
        this.logger.log(`Webhook ${event}:${payload.doctype} -> ${h.request_url}`);
      } catch (err) {
        this.logger.warn(`Webhook to ${h.request_url} failed: ${(err as Error).message}`);
      }
    }
  }
}
