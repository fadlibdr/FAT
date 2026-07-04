import { Injectable, MessageEvent } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Observable, Subject } from "rxjs";
import type { DocEventPayload } from "../doctype/hooks.service";

/**
 * Bridges document lifecycle events onto a Server-Sent Events stream so the
 * frontend can live-refresh list/form views without polling.
 */
@Injectable()
export class RealtimeService {
  private readonly subject = new Subject<MessageEvent>();

  stream(): Observable<MessageEvent> {
    return this.subject.asObservable();
  }

  private emit(event: string, p: DocEventPayload) {
    this.subject.next({ data: { event, doctype: p.doctype, name: p.doc.name } });
  }

  @OnEvent("doc.after_insert")
  onInsert(p: DocEventPayload) {
    this.emit("after_insert", p);
  }
  @OnEvent("doc.after_update")
  onUpdate(p: DocEventPayload) {
    this.emit("after_update", p);
  }
  @OnEvent("doc.after_delete")
  onDelete(p: DocEventPayload) {
    this.emit("after_delete", p);
  }
  @OnEvent("doc.on_submit")
  onSubmit(p: DocEventPayload) {
    this.emit("on_submit", p);
  }
  @OnEvent("doc.on_cancel")
  onCancel(p: DocEventPayload) {
    this.emit("on_cancel", p);
  }
}
