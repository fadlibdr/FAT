import { BadRequestException, Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";

/**
 * Employee Onboarding progress. Tracks a checklist of onboarding activities; the
 * completion percentage is kept current on every save, and the onboarding can only
 * be submitted (marked done) once every activity is Completed. Pure event-bus
 * listener, no cross-module service imports.
 */
@Injectable()
export class OnboardingListener {
  private counts(rows: Array<Record<string, unknown>>): { total: number; done: number } {
    const total = rows.length;
    const done = rows.filter((r) => String(r.status ?? "Pending") === "Completed").length;
    return { total, done };
  }

  @OnEvent("doc.before_save:Employee Onboarding")
  onSave(payload: BeforeSavePayload): void {
    const d = payload.data;
    const rows = (d.activities as Array<Record<string, unknown>>) ?? [];
    const { total, done } = this.counts(rows);
    d.total_activities = total;
    d.completed_activities = done;
    d.percent_complete = total > 0 ? Math.round((done / total) * 10000) / 100 : 0;
  }

  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Employee Onboarding", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const doc = payload.doc;
    const rows = (doc.activities as Array<Record<string, unknown>>) ?? [];
    if (rows.length === 0) {
      throw new BadRequestException(`Employee Onboarding ${doc.name}: add at least one activity`);
    }
    const { total, done } = this.counts(rows);
    if (done < total) {
      throw new BadRequestException(
        `Employee Onboarding ${doc.name}: ${total - done} of ${total} activities still pending — cannot complete onboarding`,
      );
    }
  }
}
