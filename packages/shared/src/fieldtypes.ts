/**
 * FieldType — the set of field types a DocField can have, mirroring Frappe.
 *
 * This enum is the single source of truth shared by:
 *  - the backend field-type registry (fieldtype -> Postgres column + validator)
 *  - the frontend field-renderer registry (fieldtype -> React widget)
 */
export enum FieldType {
  Data = "Data",
  SmallText = "Small Text",
  Text = "Text",
  LongText = "Long Text",
  Code = "Code",
  HTML = "HTML",
  Select = "Select",
  Int = "Int",
  Float = "Float",
  Currency = "Currency",
  Check = "Check",
  Date = "Date",
  Datetime = "Datetime",
  Link = "Link",
  DynamicLink = "Dynamic Link",
  Table = "Table",
  Attach = "Attach",
  AttachImage = "Attach Image",
  Password = "Password",
  SectionBreak = "Section Break",
  ColumnBreak = "Column Break",
}

/** Layout-only field types carry no data and produce no column. */
export const LAYOUT_FIELDTYPES: ReadonlySet<FieldType> = new Set([
  FieldType.SectionBreak,
  FieldType.ColumnBreak,
]);

/** Field types whose data lives in a separate child table, not a column. */
export const CHILD_TABLE_FIELDTYPES: ReadonlySet<FieldType> = new Set([
  FieldType.Table,
]);

/** True when the field type maps to a real column on the DocType's table. */
export function isDataFieldType(ft: FieldType): boolean {
  return !LAYOUT_FIELDTYPES.has(ft) && !CHILD_TABLE_FIELDTYPES.has(ft);
}

/** Field types that reference another DocType by its `name`. */
export const LINK_FIELDTYPES: ReadonlySet<FieldType> = new Set([
  FieldType.Link,
  FieldType.DynamicLink,
]);
