import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import type { UserContext } from "../../core/permissions/permission.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/**
 * Travel Request approval flow. A request moves Draft -> Approved/Rejected; an
 * approved request can be turned into an Expense Claim for its estimated cost,
 * which links back and marks the request Claimed. Pure SQL / generic CRUD over
 * the engine's tables — no cross-module service imports.
 */
@Injectable()
export class TravelRequestService {
  private readonly logger = new Logger(TravelRequestService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async request(name: string): Promise<Record<string, unknown>> {
    const dt = this.registry.get("Travel Request");
    if (!dt) throw new BadRequestException("Travel Request not registered");
    return this.documents.get(dt, name);
  }

  private async setStatus(name: string, fields: Record<string, unknown>): Promise<void> {
    const cols = Object.keys(fields);
    const sets = cols.map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(", ");
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Travel Request"))} SET ${sets} WHERE ${quoteIdent("name")} = $${cols.length + 1}`,
      [...Object.values(fields), name],
    );
  }

  /** Approve a Draft request (dates must be in order). */
  async approve(name: string): Promise<{ request: string; status: string }> {
    const req = await this.request(name);
    if (String(req.status ?? "Draft") !== "Draft") {
      throw new BadRequestException(`Travel Request ${name} is ${req.status}, only a Draft request can be approved`);
    }
    if (req.from_date && req.to_date && new Date(req.from_date as string) > new Date(req.to_date as string)) {
      throw new BadRequestException("From Date cannot be after To Date");
    }
    await this.setStatus(name, { status: "Approved" });
    return { request: name, status: "Approved" };
  }

  /** Reject a Draft request. */
  async reject(name: string): Promise<{ request: string; status: string }> {
    const req = await this.request(name);
    if (String(req.status ?? "Draft") !== "Draft") {
      throw new BadRequestException(`Travel Request ${name} is ${req.status}, only a Draft request can be rejected`);
    }
    await this.setStatus(name, { status: "Rejected" });
    return { request: name, status: "Rejected" };
  }

  /**
   * Raise an Expense Claim for an approved travel request's estimated cost, link
   * it back and mark the request Claimed. Refuses a non-approved or already
   * claimed request.
   */
  async makeExpenseClaim(name: string, ctx?: UserContext): Promise<{ request: string; expense_claim: string }> {
    const claimDt = this.registry.get("Expense Claim");
    if (!claimDt) throw new BadRequestException("Expense Claim not registered");
    const req = await this.request(name);
    const status = String(req.status ?? "Draft");
    if (status === "Claimed" || req.expense_claim) {
      throw new BadRequestException(`Travel Request ${name} already has Expense Claim ${req.expense_claim}`);
    }
    if (status !== "Approved") {
      throw new BadRequestException(`Travel Request ${name} is ${status}, only an Approved request can be claimed`);
    }
    const amount = Number(req.estimated_cost ?? 0);
    const claim = await this.documents.create(claimDt, ctx ?? systemContext(), {
      employee: req.employee,
      posting_date: req.to_date ?? req.from_date ?? null,
      company: req.company ?? null,
      expenses: [{ expense_type: req.expense_type ?? "Travel", description: req.purpose ?? "", amount }],
    });
    await this.setStatus(name, { status: "Claimed", expense_claim: String(claim.name) });
    this.logger.log(`Travel Request ${name} -> Expense Claim ${claim.name} (${amount})`);
    return { request: name, expense_claim: String(claim.name) };
  }
}
