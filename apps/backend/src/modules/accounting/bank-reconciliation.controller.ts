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
    const allowed = user.isSuper || user.roles.includes("Accounts User");
    if (!allowed) throw new ForbiddenException("Accounts access required");
    const matches = await this.reconciliation.autoReconcile(body?.bank_account);
    return { matched: matches.length, matches };
  }
}
