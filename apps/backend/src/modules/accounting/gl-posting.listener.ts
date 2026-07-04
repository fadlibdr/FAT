import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { DocEventPayload } from "../../core/doctype/hooks.service";

/**
 * On Sales Invoice submission the Accounting module would post GL entries
 * (debit Debtors, credit Income). It listens via the event bus so Selling need
 * not know Accounting exists. Kept as a recorded effect for this iteration.
 */
@Injectable()
export class GlPostingListener {
  private readonly logger = new Logger(GlPostingListener.name);

  @OnEvent("doc.on_submit:Sales Invoice")
  handleSalesInvoiceSubmit(payload: DocEventPayload): void {
    const total = payload.doc.grand_total ?? payload.doc.total ?? 0;
    this.logger.log(
      `Sales Invoice ${payload.doc.name} submitted: GL entry for ${total} ` +
        `(customer ${String(payload.doc.customer)}) would be posted`,
    );
  }
}
