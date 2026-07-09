import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { FatDocument } from "@fat/shared";

export type DocEvent =
  | "after_insert"
  | "after_update"
  | "after_delete"
  | "on_submit"
  | "on_cancel";

export interface DocEventPayload {
  doctype: string;
  doc: FatDocument;
  user: string;
}

/**
 * Payload for the pre-write `before_save` hook. Unlike the lifecycle events
 * above (which carry the persisted document), this carries the *raw input*
 * `data` and listeners may mutate it in place before validation and write —
 * e.g. Selling applies Pricing Rules to line rates here.
 */
export interface BeforeSavePayload {
  doctype: string;
  data: Record<string, unknown>;
  user: string;
  isNew: boolean;
}

/**
 * Thin wrapper over EventEmitter2 for document lifecycle events. Business
 * modules subscribe (e.g. Stock listens for `doc.on_submit:Sales Invoice`)
 * instead of importing each other's services — keeping module dependencies
 * unidirectional.
 */
@Injectable()
export class HooksService {
  constructor(private readonly emitter: EventEmitter2) {}

  emit(event: DocEvent, payload: DocEventPayload): void {
    this.emitter.emit(`doc.${event}`, payload);
    this.emitter.emit(`doc.${event}:${payload.doctype}`, payload);
  }

  /**
   * Awaitable pre-write hook. Listeners (`@OnEvent("doc.before_save")` or
   * `doc.before_save:<doctype>`) may mutate `payload.data` in place before the
   * engine validates and persists it. `emitAsync` awaits every listener so the
   * transform is complete before the write proceeds.
   */
  async applyBeforeSave(payload: BeforeSavePayload): Promise<void> {
    await this.emitter.emitAsync("doc.before_save", payload);
    await this.emitter.emitAsync(`doc.before_save:${payload.doctype}`, payload);
  }
}
