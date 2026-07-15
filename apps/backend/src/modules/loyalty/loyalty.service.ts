import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Loyalty redemption — the spend side of the accrual the LoyaltyListener books on
 * a Sales Invoice. A redemption is a negative Loyalty Point Entry, so the balance
 * (sum of all a customer's entries) drops by the points spent. Created through the
 * generic DocumentService — loyalty imports no other module's services.
 */
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /** Current balance for a customer (sum of accruals − redemptions). */
  async balanceOf(customer: string): Promise<number> {
    if (!this.registry.has("Loyalty Point Entry")) return 0;
    const row = (
      await this.dataSource.query(
        `SELECT coalesce(sum(${quoteIdent("points")}), 0) AS b
         FROM ${quoteIdent(tableNameFor("Loyalty Point Entry"))} WHERE ${quoteIdent("customer")} = $1`,
        [customer],
      )
    )[0];
    return Number(row?.b ?? 0);
  }

  /**
   * Redeem `points` for a customer, booking a negative point entry. Refuses a
   * non-positive amount or one greater than the current balance. Returns the new
   * balance.
   */
  async redeem(customer: string, points: number, ctx?: UserContext): Promise<{ entry: string; balance: number }> {
    const entryDt = this.registry.get("Loyalty Point Entry");
    if (!entryDt) throw new BadRequestException("Loyalty Point Entry not registered");
    if (!customer) throw new BadRequestException("Customer is required");
    const amount = Math.floor(Number(points ?? 0));
    if (amount <= 0) throw new BadRequestException("Points to redeem must be positive");
    const balance = await this.balanceOf(customer);
    if (amount > balance) {
      throw new BadRequestException(`Cannot redeem ${amount} points for ${customer}: balance is ${balance}`);
    }
    const context = ctx ?? systemContext();
    const entry = await this.documents.create(entryDt, context, {
      customer,
      entry_type: "Redemption",
      posting_date: new Date().toISOString().slice(0, 10),
      points: -amount,
    });
    this.logger.log(`Loyalty: ${customer} redeemed ${amount} pts (${entry.name})`);
    return { entry: String(entry.name), balance: balance - amount };
  }
}
