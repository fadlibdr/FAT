import { FieldType, isDataFieldType } from "@fat/shared";
import { z, ZodTypeAny } from "zod";
import type { DocFieldDef } from "@fat/shared";

/**
 * Definition of how a single fieldtype behaves across the stack:
 *  - `pgType`  : the Postgres column type for the DocType table
 *  - `toColumn`: coerce an incoming JS value into a DB-storable value
 *  - `zodFor`  : build the zod validator for a specific DocField
 */
export interface FieldTypeHandler {
  pgType: string;
  toColumn(value: unknown): unknown;
  zodFor(field: DocFieldDef): ZodTypeAny;
}

function nullableString(): FieldTypeHandler {
  return {
    pgType: "text",
    toColumn: (v) => (v === undefined || v === null || v === "" ? null : String(v)),
    zodFor: () => z.string().nullish(),
  };
}

function toNumberOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

const HANDLERS: Partial<Record<FieldType, FieldTypeHandler>> = {
  [FieldType.Data]: { ...nullableString(), pgType: "varchar(255)" },
  [FieldType.SmallText]: nullableString(),
  [FieldType.Text]: nullableString(),
  [FieldType.LongText]: nullableString(),
  [FieldType.Code]: nullableString(),
  [FieldType.HTML]: nullableString(),
  [FieldType.Attach]: nullableString(),
  [FieldType.AttachImage]: nullableString(),
  [FieldType.Password]: nullableString(),

  [FieldType.Select]: {
    pgType: "varchar(255)",
    toColumn: (v) => (v === undefined || v === null || v === "" ? null : String(v)),
    zodFor: (field) => {
      const opts = (field.options ?? "")
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (opts.length === 0) return z.string().nullish();
      return z
        .string()
        .nullish()
        .refine((v) => v === null || v === undefined || v === "" || opts.includes(v), {
          message: `must be one of: ${opts.join(", ")}`,
        });
    },
  },

  [FieldType.Link]: {
    pgType: "varchar(255)",
    toColumn: (v) => (v === undefined || v === null || v === "" ? null : String(v)),
    zodFor: () => z.string().nullish(),
  },
  [FieldType.DynamicLink]: {
    pgType: "varchar(255)",
    toColumn: (v) => (v === undefined || v === null || v === "" ? null : String(v)),
    zodFor: () => z.string().nullish(),
  },

  [FieldType.Int]: {
    pgType: "integer",
    toColumn: (v) => {
      const n = toNumberOrNull(v);
      return n === null ? null : Math.trunc(n);
    },
    zodFor: () => z.coerce.number().int().nullish(),
  },
  [FieldType.Float]: {
    pgType: "double precision",
    toColumn: toNumberOrNull,
    zodFor: () => z.coerce.number().nullish(),
  },
  [FieldType.Currency]: {
    pgType: "numeric(21,9)",
    toColumn: toNumberOrNull,
    zodFor: () => z.coerce.number().nullish(),
  },
  [FieldType.Check]: {
    pgType: "smallint",
    toColumn: (v) => {
      if (v === true || v === 1 || v === "1" || v === "true") return 1;
      return 0;
    },
    zodFor: () => z.union([z.boolean(), z.number(), z.string()]).nullish(),
  },
  [FieldType.Date]: {
    pgType: "date",
    toColumn: (v) => {
      if (v === undefined || v === null || v === "") return null;
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return String(v);
    },
    zodFor: () => z.union([z.string(), z.date()]).nullish(),
  },
  [FieldType.Datetime]: {
    pgType: "timestamptz",
    toColumn: (v) => {
      if (v === undefined || v === null || v === "") return null;
      if (v instanceof Date) return v.toISOString();
      return String(v);
    },
    zodFor: () => z.union([z.string(), z.date()]).nullish(),
  },
};

export function getFieldTypeHandler(ft: FieldType): FieldTypeHandler | undefined {
  return HANDLERS[ft];
}

/** True if this fieldtype produces a real column that we manage. */
export function hasColumn(ft: FieldType): boolean {
  return isDataFieldType(ft) && HANDLERS[ft] !== undefined;
}

/** Postgres type for a data field, or undefined for layout/child fields. */
export function pgTypeFor(ft: FieldType): string | undefined {
  return HANDLERS[ft]?.pgType;
}
