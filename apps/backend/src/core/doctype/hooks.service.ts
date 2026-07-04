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
}
