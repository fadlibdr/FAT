import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { DocEventPayload } from "../doctype/hooks.service";
import { NotificationService } from "./notification.service";

const SILENT = new Set([
  "Notification",
  "GL Entry",
  "Stock Ledger Entry",
  "Bin",
  "Version",
  "Comment",
  "File",
]);

/** Notifies a document's owner when their submittable document is submitted. */
@Injectable()
export class NotificationListener {
  constructor(private readonly notifications: NotificationService) {}

  @OnEvent("doc.on_submit")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    if (SILENT.has(payload.doctype)) return;
    const owner = String(payload.doc.owner ?? "");
    if (!owner) return;
    await this.notifications.notify({
      user: owner,
      subject: `${payload.doctype} ${payload.doc.name} submitted`,
      message: `${payload.doctype} ${payload.doc.name} has been submitted.`,
      ref_doctype: payload.doctype,
      ref_name: String(payload.doc.name),
    });
  }
}
