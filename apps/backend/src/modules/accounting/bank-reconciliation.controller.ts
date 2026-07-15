import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { BankReconciliationService } from "./bank-reconciliation.service";
import { CurrentUser } from "../../auth/current-user.decorator";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * On-demand bank reconciliation: auto-match unreconciled Bank Transactions to
 * Payment Entries (optionally scoped to one bank account). Accounts users only.
 */
@Controller("api/accounting/bank-reconcile")
export class BankReconciliationController {
  constructor(private readonly reconciliation: BankReconciliationService) {}

  @Post()
  async run(@CurrentUser() user: UserContext, @Body() body: { bank_account?: string }) {
    this.assertAllowed(user);
    const matches = await this.reconciliation.autoReconcile(body?.bank_account);
    return { matched: matches.length, matches };
  }

  @Post("match")
  async match(@CurrentUser() user: UserContext, @Body() body: { transaction: string; payment_entry: string }) {
    this.assertAllowed(user);
    return this.reconciliation.matchTransaction(body?.transaction, body?.payment_entry);
  }

  @Post("unmatch")
  async unmatch(@CurrentUser() user: UserContext, @Body() body: { transaction: string }) {
    this.assertAllowed(user);
    return this.reconciliation.unmatchTransaction(body?.transaction);
  }

  private assertAllowed(user: UserContext): void {
    if (!user.isSuper && !user.roles.includes("Accounts User")) {
      throw new ForbiddenException("Accounts access required");
    }
  }
}
