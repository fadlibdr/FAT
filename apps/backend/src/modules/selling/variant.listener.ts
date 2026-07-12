import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { BeforeSavePayload } from "../../core/doctype/hooks.service";
import { VariantService } from "./variant.service";

/**
 * Enforces Item template/variant invariants before write. suppressErrors:false so
 * a validation error aborts the save instead of being swallowed by the emitter.
 */
@Injectable()
export class VariantListener {
  constructor(private readonly variants: VariantService) {}

  @OnEvent("doc.before_save:Item", { suppressErrors: false })
  async onItemSave(payload: BeforeSavePayload): Promise<void> {
    await this.variants.validate(payload.data, payload.isNew ? undefined : String(payload.data.name ?? ""));
  }
}
