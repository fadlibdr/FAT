import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Payment Request lifecycle. On submit a request moves to Requested; the
 * make-payment action turns it into a draft Payment Entry (Receive for a
 * Sales Invoice, Pay for a Purchase Invoice), linking the two and marking the
 * request Paid. Pure use of DocumentService; no cross-module service imports.
 */
@Injectable()
export class PaymentRequestService {
  private readonly logger = new Logger(PaymentRequestService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @OnEvent("doc.on_submit:Payment Request")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    await this.setStatus(String(payload.doc.name), "Requested");
  }

  @OnEvent("doc.on_cancel:Payment Request")
  async onCancel(payload: DocEventPayload): Promise<void> {
    await this.setStatus(String(payload.doc.name), "Cancelled");
  }

  private async setStatus(name: string, status: string, paymentEntry?: string): Promise<void> {
    const fields: Record<string, unknown> = { status };
    if (paymentEntry) fields.payment_entry = paymentEntry;
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Payment Request"))} SET ${sets}
       WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  async makePayment(name: string, ctx?: UserContext): Promise<string> {
    const prDt = this.registry.get("Payment Request");
    const peDt = this.registry.get("Payment Entry");
    if (!prDt || !peDt) throw new BadRequestException("Payment Request / Payment Entry not registered");
    const context = ctx ?? systemContext();
    const pr = await this.documents.get(prDt, name);
    if ((pr.docstatus ?? 0) !== 1) throw new BadRequestException("Payment Request must be submitted");
    if (pr.payment_entry) throw new BadRequestException(`Already paid via ${pr.payment_entry}`);

    const isReceive = String(pr.reference_doctype ?? "Sales Invoice") !== "Purchase Invoice";
    const amount = Number(pr.amount ?? 0);
    const references = pr.reference_name
      ? [{
          reference_doctype: pr.reference_doctype,
          reference_name: pr.reference_name,
          allocated_amount: amount,
        }]
      : [];
    const pe = await this.documents.create(peDt, context, {
      payment_type: isReceive ? "Receive" : "Pay",
      party: pr.party,
      posting_date: new Date().toISOString().slice(0, 10),
      paid_amount: amount,
      references,
    });
    await this.setStatus(name, "Paid", String(pe.name));
    this.logger.log(`Payment Request ${name} -> draft Payment Entry ${pe.name}`);
    return String(pe.name);
  }
}
