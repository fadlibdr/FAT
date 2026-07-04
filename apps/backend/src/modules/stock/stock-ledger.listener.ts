import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { DocEventPayload } from "../../core/doctype/hooks.service";

/**
 * Demonstrates event-driven cross-module coupling: the Stock module reacts to a
 * Stock Entry submission without any other module importing it. A production
 * build would post Stock Ledger Entries here; for now it records the effect.
 */
@Injectable()
export class StockLedgerListener {
  private readonly logger = new Logger(StockLedgerListener.name);

  @OnEvent("doc.on_submit:Stock Entry")
  handleStockEntrySubmit(payload: DocEventPayload): void {
    const items = (payload.doc.items as Array<Record<string, unknown>>) ?? [];
    this.logger.log(
      `Stock Entry ${payload.doc.name} submitted by ${payload.user}: ` +
        `${items.length} ledger movement(s) would be posted`,
    );
  }
}
