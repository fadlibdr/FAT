import { BadRequestException, Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { DocEventPayload } from "../../core/doctype/hooks.service";

/**
 * Non Conformance close control. A quality Non Conformance is raised (draft) when
 * a defect is found and closed (submitted) once it is resolved — but it cannot be
 * closed without a recorded corrective action, so a closed NCR always documents
 * what was done. Pure event-bus listener, no cross-module service imports.
 */
@Injectable()
export class NonConformanceListener {
  // suppressErrors:false so a thrown gate error aborts the submit.
  @OnEvent("doc.before_submit:Non Conformance", { suppressErrors: false })
  gate(payload: DocEventPayload): void {
    const doc = payload.doc;
    if (!String(doc.subject ?? "").trim()) {
      throw new BadRequestException("A Non Conformance needs a subject");
    }
    if (!String(doc.corrective_action ?? "").trim()) {
      throw new BadRequestException(
        `Non Conformance ${doc.name}: a corrective action is required before it can be closed`,
      );
    }
  }
}
