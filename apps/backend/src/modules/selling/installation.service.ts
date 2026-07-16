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

/** Tolerance so floating-point sums don't trip an exact-quantity comparison. */
const TOL = 0.0001;

/**
 * Installation Notes record the on-site installation of items already shipped on
 * a submitted Delivery Note. `makeInstallationNote` drafts a note pre-filled with
 * the still-to-install quantity per item; on submit (or cancel) the linked
 * Delivery Note's `installation_status` is recomputed from the installed-so-far
 * total (To Install → Partly Installed → Fully Installed). Pure SQL over sibling
 * tables — Selling imports no other module's services. The over-install gate
 * lives in InstallationGateListener.
 */
@Injectable()
export class InstallationService {
  private readonly logger = new Logger(InstallationService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Draft an Installation Note from a submitted Delivery Note, pulling each line's
   * outstanding-to-install quantity (delivered − already installed on other
   * submitted notes). Refuses a non-submitted or return delivery, or one that is
   * already fully installed.
   */
  async makeInstallationNote(dnName: string, ctx?: UserContext): Promise<string> {
    const dnDt = this.registry.get("Delivery Note");
    const inDt = this.registry.get("Installation Note");
    if (!dnDt || !inDt) throw new BadRequestException("Delivery Note or Installation Note not registered");
    const context = ctx ?? systemContext();

    const note = await this.documents.get(dnDt, dnName);
    if ((note.docstatus ?? 0) !== 1) throw new BadRequestException("Delivery Note must be submitted");
    if (Boolean(note.is_return)) throw new BadRequestException("Cannot install a return Delivery Note");

    const delivered = await this.deliveredByItem(dnName);
    const installed = await this.installedByItem(dnName);
    const lines: Array<Record<string, unknown>> = [];
    for (const [item, del] of delivered) {
      const rem = del - (installed.get(item) ?? 0);
      if (rem > TOL) lines.push({ item_code: item, qty: rem });
    }
    if (lines.length === 0) throw new BadRequestException(`Delivery Note ${dnName} is already fully installed`);

    const inst = await this.documents.create(inDt, context, {
      customer: note.customer,
      delivery_note: dnName,
      installation_date: new Date().toISOString().slice(0, 10),
      items: lines,
    });
    this.logger.log(`Delivery Note ${dnName} -> Installation Note ${inst.name} (${lines.length} item(s))`);
    return String(inst.name);
  }

  @OnEvent("doc.on_submit:Installation Note")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Installation Note"))}
       SET ${quoteIdent("status")} = 'Submitted' WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
    await this.recompute(String(payload.doc.delivery_note ?? ""));
  }

  @OnEvent("doc.on_cancel:Installation Note")
  async onCancel(payload: DocEventPayload): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Installation Note"))}
       SET ${quoteIdent("status")} = 'Cancelled' WHERE ${quoteIdent("name")} = $1`,
      [String(payload.doc.name)],
    );
    await this.recompute(String(payload.doc.delivery_note ?? ""));
  }

  /** Recompute a Delivery Note's installation_status from its installed-so-far total. */
  private async recompute(dnName: string): Promise<void> {
    if (!dnName || !this.registry.has("Delivery Note")) return;
    const delivered = await this.deliveredByItem(dnName);
    const installed = await this.installedByItem(dnName);
    let deliveredTotal = 0;
    let installedTotal = 0;
    for (const [item, del] of delivered) {
      deliveredTotal += del;
      installedTotal += Math.min(installed.get(item) ?? 0, del);
    }
    const status =
      installedTotal <= TOL
        ? "To Install"
        : installedTotal + TOL >= deliveredTotal
          ? "Fully Installed"
          : "Partly Installed";
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Delivery Note"))}
       SET ${quoteIdent("installation_status")} = $1 WHERE ${quoteIdent("name")} = $2`,
      [status, dnName],
    );
    this.logger.log(`Delivery Note ${dnName}: installation_status = ${status}`);
  }

  /** Delivered quantity per item on a Delivery Note. */
  private async deliveredByItem(dnName: string): Promise<Map<string, number>> {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("item_code")} AS item, coalesce(sum(${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor("Delivery Note Item"))} WHERE ${quoteIdent("parent")} = $1
       GROUP BY ${quoteIdent("item_code")}`,
      [dnName],
    );
    return new Map(rows.map((r) => [String(r.item), Number(r.qty ?? 0)]));
  }

  /** Quantity per item already installed against a Delivery Note (submitted notes only). */
  private async installedByItem(dnName: string): Promise<Map<string, number>> {
    if (!this.registry.has("Installation Note")) return new Map();
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT c.${quoteIdent("item_code")} AS item, coalesce(sum(c.${quoteIdent("qty")}), 0) AS qty
       FROM ${quoteIdent(tableNameFor("Installation Note Item"))} c
       JOIN ${quoteIdent(tableNameFor("Installation Note"))} p ON c.${quoteIdent("parent")} = p.${quoteIdent("name")}
       WHERE p.${quoteIdent("delivery_note")} = $1 AND p.${quoteIdent("docstatus")} = 1
       GROUP BY c.${quoteIdent("item_code")}`,
      [dnName],
    );
    return new Map(rows.map((r) => [String(r.item), Number(r.qty ?? 0)]));
  }
}
