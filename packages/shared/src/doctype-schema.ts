import { z } from "zod";
import { FieldType } from "./fieldtypes";

/** Naming rules mirror Frappe's `autoname` options (subset). */
export const NamingRuleSchema = z.union([
  z.literal("hash"), // random name
  z.literal("prompt"), // user supplies name
  z.string().regex(/^field:[a-z0-9_]+$/), // name = value of a field
  z.string().regex(/^series:.+$/), // name = series pattern, e.g. series:CUST-.#####
]);

export const DocFieldSchema = z.object({
  fieldname: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "fieldname must be snake_case"),
  label: z.string().optional(),
  fieldtype: z.nativeEnum(FieldType),
  /** For Link -> target DocType; for Select -> newline/comma separated options. */
  options: z.string().optional(),
  reqd: z.boolean().optional().default(false),
  unique: z.boolean().optional().default(false),
  read_only: z.boolean().optional().default(false),
  hidden: z.boolean().optional().default(false),
  in_list_view: z.boolean().optional().default(false),
  in_standard_filter: z.boolean().optional().default(false),
  default: z.string().optional(),
  description: z.string().optional(),
  /** Field-level permission level; fields > 0 require matching permlevel access. */
  permlevel: z.number().int().min(0).optional().default(0),
  /** For Dynamic Link: the fieldname whose value names the target DocType. */
  options_field: z.string().optional(),
});

export type DocFieldDef = z.infer<typeof DocFieldSchema>;

export const DocPermSchema = z.object({
  role: z.string(),
  read: z.union([z.boolean(), z.number()]).optional(),
  write: z.union([z.boolean(), z.number()]).optional(),
  create: z.union([z.boolean(), z.number()]).optional(),
  delete: z.union([z.boolean(), z.number()]).optional(),
  submit: z.union([z.boolean(), z.number()]).optional(),
  cancel: z.union([z.boolean(), z.number()]).optional(),
  report: z.union([z.boolean(), z.number()]).optional(),
  if_owner: z.union([z.boolean(), z.number()]).optional(),
  permlevel: z.number().int().min(0).optional().default(0),
});

export type DocPermDef = z.infer<typeof DocPermSchema>;

export const DocTypeSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9 _-]*$/),
  module: z.string(),
  naming_rule: NamingRuleSchema.optional().default("hash"),
  /** Child (grid) DocTypes are stored in their own table with parent columns. */
  istable: z.boolean().optional().default(false),
  is_submittable: z.boolean().optional().default(false),
  /** DocType whose records are the single source of navigation title. */
  title_field: z.string().optional(),
  fields: z.array(DocFieldSchema).default([]),
  permissions: z.array(DocPermSchema).default([]),
});

export type DocTypeDef = z.infer<typeof DocTypeSchema>;

/** Standard columns present on every DocType table (Frappe convention). */
export const STANDARD_COLUMNS = [
  "name",
  "owner",
  "creation",
  "modified",
  "modified_by",
  "docstatus",
  "idx",
] as const;

/** Additional standard columns present on child tables. */
export const CHILD_STANDARD_COLUMNS = [
  "parent",
  "parenttype",
  "parentfield",
] as const;

/** A stored document as returned by the API (base columns + field values). */
export interface FatDocument {
  name: string;
  owner?: string | null;
  creation?: string | null;
  modified?: string | null;
  modified_by?: string | null;
  docstatus?: number;
  idx?: number;
  [field: string]: unknown;
}

/** Meta payload the frontend uses to render list/form views. */
export interface DocTypeMeta {
  name: string;
  module: string;
  naming_rule: string;
  istable: boolean;
  is_submittable: boolean;
  title_field?: string | null;
  fields: DocFieldDef[];
  permissions: import("./permissions").DocTypePermissions;
}
