"use client";

import type { DocFieldDef } from "@fat/shared";
import { FieldType } from "@fat/shared";
import type { FieldProps } from "./types";
import { DataField, TextAreaField } from "./DataField";
import { SelectField } from "./SelectField";
import { CheckField } from "./CheckField";
import { NumberField } from "./NumberField";
import { DateField } from "./DateField";
import { LinkField } from "./LinkField";
import { TableField } from "./TableField";

const REGISTRY: Partial<Record<FieldType, (p: FieldProps) => JSX.Element>> = {
  [FieldType.Data]: DataField,
  [FieldType.Password]: DataField,
  [FieldType.Attach]: DataField,
  [FieldType.AttachImage]: DataField,
  [FieldType.SmallText]: TextAreaField,
  [FieldType.Text]: TextAreaField,
  [FieldType.LongText]: TextAreaField,
  [FieldType.Code]: TextAreaField,
  [FieldType.HTML]: TextAreaField,
  [FieldType.Select]: SelectField,
  [FieldType.Check]: CheckField,
  [FieldType.Int]: NumberField,
  [FieldType.Float]: NumberField,
  [FieldType.Currency]: NumberField,
  [FieldType.Date]: DateField,
  [FieldType.Datetime]: DateField,
  [FieldType.Link]: LinkField,
  [FieldType.DynamicLink]: DataField,
  [FieldType.Table]: TableField,
};

export function renderField(
  field: DocFieldDef,
  value: unknown,
  onChange: (v: unknown) => void,
  disabled?: boolean,
): JSX.Element {
  const Component = REGISTRY[field.fieldtype as FieldType] ?? DataField;
  return <Component field={field} value={value} onChange={onChange} disabled={disabled} />;
}
