import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import type { UserContext } from "../../core/permissions/permission.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Engagement housekeeping. The EngagementListener sets a Contract's status when it
 * is submitted, but a contract that was Active then keeps that status past its end
 * date. This sweep flips any submitted, Active contract whose end date has passed
 * to Expired, and renews a contract into the next period. Pure SQL / generic CRUD
 * over the engine's tables — engagement imports no other module's services.
 */
@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private isoDay(value: unknown): string {
    return new Date(value as string).toISOString().slice(0, 10);
  }

  private addDays(iso: string, days: number): string {
    const d = new Date(iso);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Renew a submitted contract into the next period: a new draft Contract starting
   * the day after the original ends, spanning the same duration (or `days` when
   * given), copying party/value/terms and linked back via `renewed_from`. The
   * original is flagged `renewed` so it cannot be renewed twice. Refuses a
   * non-submitted or already-renewed contract.
   */
  async renewContract(name: string, days?: number, ctx?: UserContext): Promise<{ contract: string; renewal: string }> {
    const dt = this.registry.get("Contract");
    if (!dt) throw new BadRequestException("Contract not registered");
    const src = await this.documents.get(dt, name);
    if ((src.docstatus ?? 0) !== 1) throw new BadRequestException("Only a submitted contract can be renewed");
    if (Boolean(src.renewed)) throw new BadRequestException(`Contract ${name} has already been renewed`);

    const oldStart = this.isoDay(src.start_date);
    const oldEnd = this.isoDay(src.end_date);
    const span = days && days > 0
      ? days
      : Math.max(1, Math.round((new Date(oldEnd).getTime() - new Date(oldStart).getTime()) / 86_400_000));
    const newStart = this.addDays(oldEnd, 1);
    const newEnd = this.addDays(newStart, span);

    const context = ctx ?? systemContext();
    const renewal = await this.documents.create(dt, context, {
      party_type: src.party_type,
      party: src.party,
      start_date: newStart,
      end_date: newEnd,
      contract_value: src.contract_value ?? null,
      terms: src.terms ?? null,
      renewed_from: name,
    });
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Contract"))} SET ${quoteIdent("renewed")} = 1
       WHERE ${quoteIdent("name")} = $1`,
      [name],
    );
    this.logger.log(`Contract ${name} renewed -> ${renewal.name} (${newStart}..${newEnd})`);
    return { contract: name, renewal: String(renewal.name) };
  }

  /** Expire Active contracts whose end date is before `asOf` (default: today). */
  async expireContracts(asOf?: string): Promise<{ asOf: string; expired: string[] }> {
    if (!this.registry.has("Contract")) return { asOf: asOf ?? "", expired: [] };
    const date = asOf || new Date().toISOString().slice(0, 10);
    const table = quoteIdent(tableNameFor("Contract"));
    const rows = await this.dataSource.query(
      `SELECT ${quoteIdent("name")} AS name FROM ${table}
       WHERE ${quoteIdent("docstatus")} = 1 AND ${quoteIdent("status")} = 'Active'
         AND ${quoteIdent("end_date")} IS NOT NULL AND ${quoteIdent("end_date")} < $1`,
      [date],
    );
    const expired = (rows as Array<{ name: string }>).map((r) => String(r.name));
    if (expired.length > 0) {
      await this.dataSource.query(
        `UPDATE ${table} SET ${quoteIdent("status")} = 'Expired' WHERE ${quoteIdent("name")} = ANY($1)`,
        [expired],
      );
    }
    this.logger.log(`Contract expiry as of ${date}: expired ${expired.length}`);
    return { asOf: date, expired };
  }
}
