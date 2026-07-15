import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Blanket Order release. Draws a draft Sales Order down against a submitted
 * Blanket Order for its remaining (or a requested) quantity, linked back via
 * blanket_order. The existing SalesteamListener still gates the order against the
 * blanket's remaining qty and rolls ordered_qty when it is submitted, so release
 * and enforcement stay consistent. Documents are created through the generic
 * DocumentService — salesteam imports no other module's services.
 */
@Injectable()
export class SalesteamService {
  private readonly logger = new Logger(SalesteamService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
  ) {}

  /**
   * Create a draft Sales Order releasing `qty` (default: all remaining) from a
   * submitted Blanket Order. Refuses an undrawn/non-submitted blanket, a fully
   * ordered one, or a qty beyond what remains.
   */
  async makeSalesOrder(blanketOrder: string, qty?: number, ctx?: UserContext): Promise<string> {
    const boDt = this.registry.get("Blanket Order");
    const soDt = this.registry.get("Sales Order");
    if (!boDt || !soDt) throw new BadRequestException("Blanket Order or Sales Order not registered");
    const context = ctx ?? systemContext();

    const bo = await this.documents.get(boDt, blanketOrder);
    if ((bo.docstatus ?? 0) !== 1) throw new BadRequestException("Blanket Order must be submitted");
    const total = Number(bo.total_qty ?? 0);
    const ordered = Number(bo.ordered_qty ?? 0);
    const remaining = Math.round((total - ordered) * 1e6) / 1e6;
    if (remaining <= 0) throw new BadRequestException(`Blanket Order ${blanketOrder} is fully ordered`);

    const releaseQty = qty && qty > 0 ? qty : remaining;
    if (releaseQty > remaining + 1e-9) {
      throw new BadRequestException(
        `Blanket Order ${blanketOrder}: requested ${releaseQty} exceeds remaining ${remaining}`,
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const so = await this.documents.create(soDt, context, {
      customer: bo.customer,
      transaction_date: today,
      delivery_date: (bo.to_date as string) ?? today,
      blanket_order: blanketOrder,
      items: [{ item_code: bo.item_code, qty: releaseQty, rate: Number(bo.rate ?? 0) }],
    });
    this.logger.log(`Blanket Order ${blanketOrder} -> Sales Order ${so.name} (qty ${releaseQty}/${remaining})`);
    return String(so.name);
  }
}
