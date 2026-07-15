import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Engagement housekeeping. The EngagementListener sets a Contract's status when it
 * is submitted, but a contract that was Active then keeps that status past its end
 * date. This sweep flips any submitted, Active contract whose end date has passed
 * to Expired. Pure SQL over the engine's tables — engagement imports no other
 * module's services.
 */
@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

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
