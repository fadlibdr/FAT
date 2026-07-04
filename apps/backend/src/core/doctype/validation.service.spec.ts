import { BadRequestException } from "@nestjs/common";
import { FieldType } from "@fat/shared";
import { ValidationService } from "./validation.service";
import type { LoadedDocType } from "./doctype-registry.service";

function dt(fields: LoadedDocType["fields"]): LoadedDocType {
  return {
    name: "Test",
    module: "Core",
    naming_rule: "hash",
    istable: false,
    is_submittable: false,
    title_field: null,
    fields,
    perms: [],
  };
}

describe("ValidationService", () => {
  const service = new ValidationService();

  it("rejects missing required fields on create", () => {
    const meta = dt([
      { fieldname: "title", fieldtype: FieldType.Data, reqd: true } as never,
    ]);
    expect(() => service.validate(meta, {}, true)).toThrow(BadRequestException);
  });

  it("allows missing required fields on update (partial)", () => {
    const meta = dt([
      { fieldname: "title", fieldtype: FieldType.Data, reqd: true } as never,
    ]);
    expect(() => service.validate(meta, { title: undefined }, false)).not.toThrow();
  });

  it("validates Select against its options", () => {
    const meta = dt([
      {
        fieldname: "status",
        fieldtype: FieldType.Select,
        options: "Open\nClosed",
      } as never,
    ]);
    expect(() => service.validate(meta, { status: "Open" }, false)).not.toThrow();
    expect(() => service.validate(meta, { status: "Nope" }, false)).toThrow(
      BadRequestException,
    );
  });

  it("accepts a valid create payload", () => {
    const meta = dt([
      { fieldname: "title", fieldtype: FieldType.Data, reqd: true } as never,
      { fieldname: "qty", fieldtype: FieldType.Int } as never,
    ]);
    expect(() => service.validate(meta, { title: "Hi", qty: 3 }, true)).not.toThrow();
  });
});
