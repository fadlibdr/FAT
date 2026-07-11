import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { HrService } from "./hr.service";

/**
 * Leave behaviour, all on the event bus (no cross-module service imports):
 *
 *  1. before_save on a Leave Application derives its inclusive day count from the
 *     from/to dates.
 *  2. before_submit on a Leave Application (which the approval workflow routes
 *     through) blocks approval when the employee lacks enough balance for the
 *     requested paid days — computed from submitted allocations minus submitted
 *     applications.
 */
@Injectable()
export class HrListener {
  private readonly logger = new Logger(HrListener.name);

  constructor(private readonly hr: HrService) {}

  @OnEvent("doc.before_save:Leave Application")
  onLeaveSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    d.total_leave_days = HrService.leaveDays(d.from_date, d.to_date);
  }

  // suppressErrors:false so an insufficient-balance error aborts the submit
  // instead of being swallowed by the event emitter.
  @OnEvent("doc.before_submit:Leave Application", { suppressErrors: false })
  async gateLeave(payload: DocEventPayload): Promise<void> {
    const doc = payload.doc;
    const employee = String(doc.employee ?? "");
    const leaveType = String(doc.leave_type ?? "");
    if (!employee || !leaveType) return;
    const requested = Number(doc.total_leave_days ?? 0) || HrService.leaveDays(doc.from_date, doc.to_date);
    const balance = await this.hr.balanceFor(employee, leaveType);
    if (requested > balance) {
      throw new BadRequestException(
        `Insufficient ${leaveType} balance for ${employee}: requested ${requested}, available ${balance}`,
      );
    }
    this.logger.log(`Leave ${doc.name} approved: ${requested} ${leaveType} day(s), balance was ${balance}`);
  }
}
