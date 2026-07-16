import { BadRequestException, Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";

/** Small tolerance for float qty comparisons. */
const TOL = 0.0001;

/**
 * Purchase Receipt quality control. Each line may reject part of the received
 * quantity; only the accepted balance is taken into stock (see StockLedger). This
 * listener keeps `accepted_qty` current on save and blocks a submit whose rejected
 * quantity is negative or exceeds what was received. Pure event-bus listener, no
 * cross-module service imports.
 */
@Injectable()
export class PurchaseRejectionListener {
  @OnEvent("doc.before_save:Purchase Receipt")
  onSave(payload: BeforeSavePayload): void {
    const rows = (payload.data.items as Array<Record<string, unknown>>) ?? [];
    for (const row of rows) {
      const qty = Number(row.qty ?? 0);
      const rejected = Number(row.rejected_qty ?? 0);
      row.accepted_qty = Math.round(Math.max(0, qty - rejected) * 1e6) / 1e6;
    }
  }

  // suppressErrors:false so a bad rejected qty aborts the submit.
  @OnEvent("doc.before_submit:Purchase Receipt", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    if (Boolean(payload.doc.is_return)) return; // a return sends the full qty back
    for (const row of (payload.doc.items as Array<Record<string, unknown>>) ?? []) {
      const qty = Number(row.qty ?? 0);
      const rejected = Number(row.rejected_qty ?? 0);
      if (rejected < 0) {
        throw new BadRequestException(`Item ${row.item_code}: rejected qty cannot be negative`);
      }
      if (rejected > qty + TOL) {
        throw new BadRequestException(
          `Item ${row.item_code}: rejected qty ${rejected} exceeds received qty ${qty}`,
        );
      }
    }
  }
}
