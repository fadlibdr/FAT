import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import type { UserContext } from "../../core/permissions/permission.service";

type InvoiceKind = "Sales Invoice" | "Purchase Invoice";

/**
 * Payment convenience: draw a draft Payment Entry pre-filled from an outstanding
 * invoice — Receive against a Sales Invoice, Pay against a Purchase Invoice. The
 * GL-posting listener still posts the cash/party GL and reconciles the reference
 * (reducing the invoice's outstanding) when the Payment Entry is submitted, so
 * this only builds the draft. Created through the generic DocumentService —
 * accounting posts GL through events, never by importing another module.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
  ) {}

  /**
   * Build a draft Payment Entry settling `invoice`. Amount is the invoice's open
   * outstanding (falling back to its grand total for a freshly-submitted invoice
   * whose total roll-up may not yet be reflected). Refuses a non-submitted or
   * fully-settled invoice.
   */
  async makePaymentEntry(kind: InvoiceKind, invoice: string, ctx?: UserContext): Promise<string> {
    const invDt = this.registry.get(kind);
    const peDt = this.registry.get("Payment Entry");
    if (!invDt || !peDt) throw new BadRequestException(`${kind} or Payment Entry not registered`);
    const context = ctx ?? systemContext();
    const inv = await this.documents.get(invDt, invoice);
    if ((inv.docstatus ?? 0) !== 1) throw new BadRequestException(`${kind} must be submitted`);

    const receive = kind === "Sales Invoice";
    const party = String((receive ? inv.customer : inv.supplier) ?? "");
    if (!party) throw new BadRequestException(`${kind} ${invoice} has no party`);

    // Use the posted outstanding; a null (not 0) means the GL post that stamps it
    // has not landed yet on a freshly-submitted invoice — fall back to its grand
    // total there. An explicit 0 means fully settled, so leave it 0 and reject.
    const raw = inv.outstanding_amount;
    const amount =
      raw === null || raw === undefined
        ? Number(inv.grand_total ?? inv.total ?? 0)
        : Number(raw);
    if (amount <= 0) throw new BadRequestException(`${kind} ${invoice} has nothing outstanding to settle`);

    const pe = await this.documents.create(peDt, context, {
      payment_type: receive ? "Receive" : "Pay",
      posting_date: new Date().toISOString().slice(0, 10),
      party,
      paid_amount: amount,
      references: [{ reference_doctype: kind, reference_name: invoice, allocated_amount: amount }],
    });
    this.logger.log(`${kind} ${invoice} -> draft Payment Entry ${pe.name} (${receive ? "Receive" : "Pay"} ${amount})`);
    return String(pe.name);
  }
}
