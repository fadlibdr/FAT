import { BadRequestException, ForbiddenException, Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { DoctypeRegistryService } from "../doctype/doctype-registry.service";
import { DocumentService } from "../doctype/document.service";
import { tableNameFor, quoteIdent } from "../doctype/schema-sync.service";
import type { UserContext } from "../permissions/permission.service";

interface Transition {
  state: string;
  action: string;
  next_state: string;
  allowed: string | null;
}
interface WorkflowDef {
  name: string;
  state_field: string;
  states: { state: string; doc_status: string }[];
  transitions: Transition[];
}

/**
 * Minimal workflow engine. A `Workflow` (active, for a document_type) defines
 * states (each mapping to a docstatus) and role-gated transitions. Applying an
 * action advances the document's `workflow_state` and, when the target state's
 * docstatus is 1/2, submits/cancels via DocumentService.
 */
@Injectable()
export class WorkflowService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly registry: DoctypeRegistryService,
    private readonly documents: DocumentService,
  ) {}

  async getWorkflow(doctype: string): Promise<WorkflowDef | null> {
    if (!this.registry.has("Workflow")) return null;
    const wf = (
      await this.dataSource.query(
        `SELECT ${quoteIdent("name")} AS name,
                coalesce(${quoteIdent("workflow_state_field")}, 'workflow_state') AS state_field
         FROM ${quoteIdent(tableNameFor("Workflow"))}
         WHERE ${quoteIdent("document_type")} = $1 AND ${quoteIdent("is_active")} = 1
         LIMIT 1`,
        [doctype],
      )
    )[0];
    if (!wf) return null;
    const states = await this.dataSource.query(
      `SELECT ${quoteIdent("state")} AS state, ${quoteIdent("doc_status")} AS doc_status
       FROM ${quoteIdent(tableNameFor("Workflow Document State"))} WHERE ${quoteIdent("parent")} = $1
       ORDER BY ${quoteIdent("idx")}`,
      [wf.name],
    );
    const transitions = await this.dataSource.query(
      `SELECT ${quoteIdent("state")} AS state, ${quoteIdent("action")} AS action,
              ${quoteIdent("next_state")} AS next_state, ${quoteIdent("allowed")} AS allowed
       FROM ${quoteIdent(tableNameFor("Workflow Transition"))} WHERE ${quoteIdent("parent")} = $1
       ORDER BY ${quoteIdent("idx")}`,
      [wf.name],
    );
    return { name: wf.name, state_field: wf.state_field, states, transitions };
  }

  private async currentState(
    doctype: string,
    name: string,
    wf: WorkflowDef,
  ): Promise<string> {
    const row = (
      await this.dataSource.query(
        `SELECT ${quoteIdent(wf.state_field)} AS s FROM ${quoteIdent(tableNameFor(doctype))}
         WHERE ${quoteIdent("name")} = $1`,
        [name],
      )
    )[0];
    return row?.s ?? wf.states[0]?.state ?? "";
  }

  private canUse(t: Transition, ctx: UserContext): boolean {
    if (ctx.isSuper) return true;
    if (!t.allowed) return true;
    return ctx.roles.includes(t.allowed);
  }

  async getActions(doctype: string, name: string, ctx: UserContext) {
    const wf = await this.getWorkflow(doctype);
    if (!wf) return { state: null, actions: [] as string[] };
    const state = await this.currentState(doctype, name, wf);
    const actions = wf.transitions
      .filter((t) => t.state === state && this.canUse(t, ctx))
      .map((t) => t.action);
    return { state, actions };
  }

  async applyAction(
    doctype: string,
    name: string,
    action: string,
    ctx: UserContext,
  ) {
    const wf = await this.getWorkflow(doctype);
    if (!wf) throw new BadRequestException(`No active workflow for ${doctype}`);
    const state = await this.currentState(doctype, name, wf);
    const transition = wf.transitions.find(
      (t) => t.state === state && t.action === action,
    );
    if (!transition) {
      throw new BadRequestException(`Action '${action}' not allowed from '${state}'`);
    }
    if (!this.canUse(transition, ctx)) {
      throw new ForbiddenException(`You may not perform '${action}'`);
    }

    // Advance the workflow state (raw update so it works pre/post submit).
    await this.dataSource.query(
      `UPDATE ${quoteIdent(tableNameFor(doctype))} SET ${quoteIdent(wf.state_field)} = $1
       WHERE ${quoteIdent("name")} = $2`,
      [transition.next_state, name],
    );

    // Map the target state's docstatus to a submit/cancel if applicable.
    const target = wf.states.find((s) => s.state === transition.next_state);
    const dt = this.registry.getOrThrow(doctype);
    if (dt.is_submittable && target) {
      const current = (
        await this.dataSource.query(
          `SELECT ${quoteIdent("docstatus")} AS d FROM ${quoteIdent(tableNameFor(doctype))}
           WHERE ${quoteIdent("name")} = $1`,
          [name],
        )
      )[0];
      const cur = Number(current?.d ?? 0);
      if (target.doc_status === "1" && cur === 0) {
        await this.documents.setDocStatus(dt, ctx, name, 1);
      } else if (target.doc_status === "2" && cur === 1) {
        await this.documents.setDocStatus(dt, ctx, name, 2);
      }
    }
    return { state: transition.next_state };
  }
}
