import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { DocEventPayload } from "../../core/doctype/hooks.service";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Bank Guarantee lifecycle. Submitting a guarantee makes it Active; a periodic
 * expiry run lapses Active guarantees past their end date; a Receiving guarantee
 * can be Claimed if the counterparty defaults before it lapses. A before_submit
 * gate keeps the validity window sane. Pure SQL over sibling tables; Accounting
 * imports no other module's services.
 */
@Injectable()
export class BankGuaranteeService {
  private readonly logger = new Logger(BankGuaranteeService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** UTC YYYY-MM-DD for a date value. */
  private isoDay(value: unknown): string {
    const d = value instanceof Date ? value : new Date(String(value));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  private today(): string {
    return this.isoDay(new Date());
  }

  // suppressErrors:false so an invalid validity window aborts the submit.
  @OnEvent("doc.before_submit:Bank Guarantee", { suppressErrors: false })
  gateWindow(payload: DocEventPayload): void {
    const doc = payload.doc;
    if (doc.start_date && doc.end_date && this.isoDay(doc.end_date) < this.isoDay(doc.start_date)) {
      throw new BadRequestException("Bank Guarantee End Date cannot be before Start Date");
    }
  }

  @OnEvent("doc.on_submit:Bank Guarantee")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    await this.setStatus(String(payload.doc.name), "Active");
  }

  @OnEvent("doc.on_cancel:Bank Guarantee")
  async onCancel(payload: DocEventPayload): Promise<void> {
    await this.setStatus(String(payload.doc.name), "Cancelled");
  }

  /**
   * Lapse every Active bank guarantee whose end date is on or before `asOf`
   * (default today) to Expired. Returns the guarantees lapsed.
   */
  async expireBankGuarantees(asOf?: string): Promise<{ expired: string[] }> {
    if (!this.registry.has("Bank Guarantee")) return { expired: [] };
    const cutoff = asOf ? this.isoDay(asOf) : this.today();
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name FROM ${quoteIdent(tableNameFor("Bank Guarantee"))}
       WHERE ${quoteIdent("docstatus")} = 1 AND ${quoteIdent("status")} = 'Active'
         AND ${quoteIdent("end_date")} <= $1`,
      [cutoff],
    );
    const names = rows.map((r) => String(r.name));
    if (names.length > 0) {
      await this.dataSource.query(
        `UPDATE ${quoteIdent(tableNameFor("Bank Guarantee"))} SET ${quoteIdent("status")} = 'Expired'
         WHERE ${quoteIdent("name")} = ANY($1)`,
        [names],
      );
      this.logger.log(`Bank Guarantee expiry (as of ${cutoff}): lapsed ${names.length} — ${names.join(", ")}`);
    }
    return { expired: names };
  }

  /**
   * Claim a Receiving bank guarantee (the counterparty defaulted): mark it
   * Claimed. Only a submitted, Active, Receiving guarantee can be claimed.
   */
  async claimBankGuarantee(name: string): Promise<{ bank_guarantee: string; status: string }> {
    if (!this.registry.has("Bank Guarantee")) throw new BadRequestException("Bank Guarantee not registered");
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("docstatus")} AS docstatus, ${quoteIdent("status")} AS status,
                ${quoteIdent("bg_type")} AS bg_type
         FROM ${quoteIdent(tableNameFor("Bank Guarantee"))} WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    if (!row) throw new BadRequestException(`Bank Guarantee ${name} not found`);
    if (Number(row.docstatus ?? 0) !== 1) throw new BadRequestException(`Bank Guarantee ${name} must be submitted`);
    if (String(row.bg_type) !== "Receiving") {
      throw new BadRequestException(`Only a Receiving Bank Guarantee can be claimed (${name} is ${row.bg_type})`);
    }
    if (String(row.status) !== "Active") {
      throw new BadRequestException(`Bank Guarantee ${name} must be Active to claim (is ${row.status})`);
    }
    await this.setStatus(name, "Claimed");
    this.logger.log(`Bank Guarantee ${name} claimed`);
    return { bank_guarantee: name, status: "Claimed" };
  }

  private async setStatus(name: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Bank Guarantee"))} SET ${quoteIdent("status")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [status, name],
    );
  }
}
