import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";
import type { UserContext } from "../../core/permissions/permission.service";

/**
 * Maintenance scheduling: draw the next Maintenance Visit from a submitted
 * Maintenance Schedule, pre-filled from the earliest still-pending scheduled
 * visit. Submitting the visit closes that scheduled slot via the
 * MaintenanceListener. Created through the generic DocumentService — maintenance
 * imports no other module's services.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async makeVisit(schedule: string, ctx?: UserContext): Promise<string> {
    const schDt = this.registry.get("Maintenance Schedule");
    const visitDt = this.registry.get("Maintenance Visit");
    if (!schDt || !visitDt) throw new BadRequestException("Maintenance Schedule / Visit not registered");
    const context = ctx ?? systemContext();
    const sch = await this.documents.get(schDt, schedule);
    if ((sch.docstatus ?? 0) !== 1) throw new BadRequestException("Maintenance Schedule must be submitted");

    const pending = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("scheduled_date")} AS d FROM ${quoteIdent(tableNameFor("Maintenance Schedule Detail"))}
         WHERE ${quoteIdent("parent")} = $1 AND ${quoteIdent("status")} = 'Pending'
         ORDER BY ${quoteIdent("scheduled_date")}, ${quoteIdent("idx")} LIMIT 1`,
        [schedule],
      )
    )[0];
    if (!pending) throw new BadRequestException(`Maintenance Schedule ${schedule} has no pending visits`);

    const visit = await this.documents.create(visitDt, context, {
      customer: sch.customer,
      item_code: sch.item_code,
      serial_no: sch.serial_no ?? null,
      maintenance_schedule: schedule,
      visit_date: pending.d,
    });
    this.logger.log(`Maintenance Schedule ${schedule} -> Maintenance Visit ${visit.name} (${pending.d})`);
    return String(visit.name);
  }

  /**
   * Draw a draft Maintenance Visit from an open Warranty Claim, pre-filled with
   * the claim's customer, item and serial and linked back via `warranty_claim`.
   * Submitting the visit resolves the claim (see MaintenanceListener). Refuses a
   * claim that is not Open.
   */
  async makeVisitFromClaim(claimName: string, ctx?: UserContext): Promise<string> {
    const claimDt = this.registry.get("Warranty Claim");
    const visitDt = this.registry.get("Maintenance Visit");
    if (!claimDt || !visitDt) throw new BadRequestException("Warranty Claim / Maintenance Visit not registered");
    const context = ctx ?? systemContext();
    const claim = await this.documents.get(claimDt, claimName);
    if (String(claim.status ?? "Open") !== "Open") {
      throw new BadRequestException(`Warranty Claim ${claimName} is not Open (is ${claim.status})`);
    }
    const visit = await this.documents.create(visitDt, context, {
      customer: claim.customer,
      item_code: claim.item_code ?? null,
      serial_no: claim.serial_no ?? null,
      warranty_claim: claimName,
      visit_date: new Date().toISOString().slice(0, 10),
      work_done: claim.complaint ?? null,
    });
    this.logger.log(`Warranty Claim ${claimName} -> Maintenance Visit ${visit.name}`);
    return String(visit.name);
  }
}
