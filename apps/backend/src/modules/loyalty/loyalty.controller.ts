import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import { LoyaltyService } from "./loyalty.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * A customer's loyalty balance = sum of their point entries (accruals positive,
 * redemptions negative). Read-only; the global JWT guard still applies.
 */
@Controller("api/loyalty/balance")
export class LoyaltyController {
  constructor(
    private readonly registry: DoctypeRegistryService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  @Get(":customer")
  async balance(@Param("customer") customer: string): Promise<{ customer: string; balance: number }> {
    let balance = 0;
    if (this.registry.has("Loyalty Point Entry")) {
      const row = (
        await this.dataSource.query(
          `SELECT coalesce(sum(${quoteIdent("points")}), 0) AS b
           FROM ${quoteIdent(tableNameFor("Loyalty Point Entry"))}
           WHERE ${quoteIdent("customer")} = $1`,
          [customer],
        )
      )[0];
      balance = Number(row?.b ?? 0);
    }
    return { customer, balance };
  }
}

/** Loyalty redemption endpoint (spend accrued points). */
@Controller("api/loyalty")
export class LoyaltyRedeemController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Post("redeem")
  async redeem(@CurrentUser() user: UserContext, @Body() body: { customer: string; points: number }) {
    return this.loyalty.redeem(body?.customer, body?.points, user);
  }
}
