import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type { BeforeSavePayload, DocEventPayload } from "../../core/doctype/hooks.service";
import { tableNameFor, quoteIdent } from "../../core/doctype/schema-sync.service";

/** Tolerance for the weightage-sum check. */
const TOL = 0.01;

/**
 * Employee Appraisal scoring. Two pure event-bus behaviours, no cross-module
 * imports:
 *
 *  1. before_save derives each goal's `score_earned` = weightage% × score and the
 *     appraisal's `total_score` (Σ score_earned, on a 0-5 scale).
 *  2. before_submit gates the appraisal: goal weightages must sum to 100 and each
 *     score must be within 0-5.
 */
@Injectable()
export class AppraisalListener {
  private readonly logger = new Logger(AppraisalListener.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @OnEvent("doc.before_save:Appraisal")
  onSave(payload: BeforeSavePayload): void {
    const goals = payload.data.goals as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(goals)) return;
    let total = 0;
    for (const g of goals) {
      const weightage = Number(g.weightage ?? 0);
      const score = Number(g.score ?? 0);
      const earned = Math.round((weightage / 100) * score * 1e6) / 1e6;
      g.score_earned = earned;
      total += earned;
    }
    payload.data.total_score = Math.round(total * 1e6) / 1e6;
  }

  // suppressErrors:false so a bad weightage/score set aborts the submit.
  @OnEvent("doc.before_submit:Appraisal", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const goals = (payload.doc.goals as Array<Record<string, unknown>>) ?? [];
    if (goals.length === 0) throw new BadRequestException("Appraisal needs at least one goal");
    let weightSum = 0;
    for (const g of goals) {
      const score = Number(g.score ?? 0);
      if (score < 0 || score > 5) {
        throw new BadRequestException(`Goal "${g.kra}" score ${score} is out of the 0-5 range`);
      }
      weightSum += Number(g.weightage ?? 0);
    }
    if (Math.abs(weightSum - 100) > TOL) {
      throw new BadRequestException(`Goal weightages must sum to 100 (got ${Math.round(weightSum * 100) / 100})`);
    }
    this.logger.log(`Appraisal ${payload.doc.name} passed scoring gate (total ${payload.doc.total_score})`);
  }

  @OnEvent("doc.on_submit:Appraisal")
  async onSubmit(payload: DocEventPayload): Promise<void> {
    await this.setStatus(String(payload.doc.name), "Submitted");
  }

  @OnEvent("doc.on_cancel:Appraisal")
  async onCancel(payload: DocEventPayload): Promise<void> {
    await this.setStatus(String(payload.doc.name), "Cancelled");
  }

  private async setStatus(name: string, status: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor("Appraisal"))} SET ${quoteIdent("status")} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [status, name],
    );
  }
}
