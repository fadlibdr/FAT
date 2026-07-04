import { BadRequestException, Injectable } from "@nestjs/common";
import { FieldType, isDataFieldType } from "@fat/shared";
import { getFieldTypeHandler } from "../field-types/field-type.registry";
import type { LoadedDocType } from "./doctype-registry.service";

/**
 * Metadata-driven validation. Each DocField's fieldtype supplies a zod validator
 * (from the field-type registry); requiredness is enforced on create.
 */
@Injectable()
export class ValidationService {
  /**
   * Validate an incoming payload against a DocType. Throws BadRequestException
   * with a list of field errors if anything is invalid.
   */
  validate(
    dt: LoadedDocType,
    data: Record<string, unknown>,
    isCreate: boolean,
  ): void {
    const errors: string[] = [];

    for (const field of dt.fields) {
      const ft = field.fieldtype as FieldType;
      if (!isDataFieldType(ft)) continue;
      const handler = getFieldTypeHandler(ft);
      if (!handler) continue;

      const present = Object.prototype.hasOwnProperty.call(data, field.fieldname);
      const value = data[field.fieldname];
      const empty = value === undefined || value === null || value === "";

      if (isCreate && field.reqd && empty) {
        errors.push(`${field.label ?? field.fieldname} is required`);
        continue;
      }

      if (present && !empty) {
        const parsed = handler.zodFor(field).safeParse(value);
        if (!parsed.success) {
          const msg = parsed.error.issues[0]?.message ?? "invalid value";
          errors.push(`${field.label ?? field.fieldname}: ${msg}`);
        }
      }
    }

    if (errors.length) {
      throw new BadRequestException({
        message: `Validation failed for ${dt.name}`,
        errors,
      });
    }
  }
}
