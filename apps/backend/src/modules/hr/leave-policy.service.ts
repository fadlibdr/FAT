import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { DoctypeRegistryService } from "../../core/doctype/doctype-registry.service";
import { DocumentService } from "../../core/doctype/document.service";
import { systemContext } from "../../core/permissions/system-context";
import type { UserContext } from "../../core/permissions/permission.service";

export interface AssignResult {
  policy: string;
  employee: string;
  created: Array<{ leave_type: string; allocation: string; days: number }>;
  skipped: Array<{ leave_type: string; reason: string }>;
}

/**
 * Leave Policy assignment. A policy bundles a per-leave-type annual allocation;
 * assigning it to an employee for a period creates and submits one Leave
 * Allocation per line. Each allocation still passes the Leave Allocation gate
 * (no overlap, non-negative), and a line that fails is reported as skipped rather
 * than aborting the whole run. Uses the generic DocumentService — no cross-module
 * service imports.
 */
@Injectable()
export class LeavePolicyService {
  private readonly logger = new Logger(LeavePolicyService.name);

  constructor(
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
  ) {}

  async assign(
    policyName: string,
    employee: string,
    fromDate: string,
    toDate: string,
    ctx?: UserContext,
  ): Promise<AssignResult> {
    const policyDt = this.registry.get("Leave Policy");
    const allocDt = this.registry.get("Leave Allocation");
    if (!policyDt || !allocDt) throw new BadRequestException("Leave Policy or Leave Allocation not registered");
    if (!employee) throw new BadRequestException("Employee is required");
    if (!fromDate || !toDate) throw new BadRequestException("From and To dates are required");
    if (new Date(fromDate) > new Date(toDate)) throw new BadRequestException("From Date cannot be after To Date");

    const policy = await this.documents.get(policyDt, policyName);
    const lines = (policy.details as Array<Record<string, unknown>>) ?? [];
    if (lines.length === 0) throw new BadRequestException(`Leave Policy ${policyName} has no allocation lines`);

    const context = ctx ?? systemContext();
    const created: AssignResult["created"] = [];
    const skipped: AssignResult["skipped"] = [];
    for (const line of lines) {
      const leaveType = String(line.leave_type ?? "");
      const days = Number(line.annual_allocation ?? 0);
      if (!leaveType) continue;
      try {
        const alloc = await this.documents.create(allocDt, context, {
          employee,
          leave_type: leaveType,
          from_date: fromDate,
          to_date: toDate,
          new_leaves_allocated: days,
        });
        await this.documents.setDocStatus(allocDt, context, String(alloc.name), 1);
        created.push({ leave_type: leaveType, allocation: String(alloc.name), days });
      } catch (err) {
        skipped.push({ leave_type: leaveType, reason: (err as Error).message });
      }
    }
    this.logger.log(`Leave Policy ${policyName} -> ${employee}: ${created.length} allocated, ${skipped.length} skipped`);
    return { policy: policyName, employee, created, skipped };
  }
}
