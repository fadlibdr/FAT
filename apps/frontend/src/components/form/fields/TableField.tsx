"use client";

import type { DocFieldDef } from "@fat/shared";
import { FieldType } from "@fat/shared";
import { FieldProps } from "./types";
import { useDocTypeMeta } from "@/lib/meta-client";
import { DataField } from "./DataField";
import { SelectField } from "./SelectField";
import { CheckField } from "./CheckField";
import { NumberField } from "./NumberField";
import { DateField } from "./DateField";
import { LinkField } from "./LinkField";

type Row = Record<string, unknown>;

function Cell({
  field,
  value,
  onChange,
}: {
  field: DocFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const ft = field.fieldtype as FieldType;
  const props = { field, value, onChange };
  switch (ft) {
    case FieldType.Select:
      return <SelectField {...props} />;
    case FieldType.Check:
      return <CheckField {...props} />;
    case FieldType.Int:
    case FieldType.Float:
    case FieldType.Currency:
      return <NumberField {...props} />;
    case FieldType.Date:
      return <DateField {...props} />;
    case FieldType.Datetime:
      return <DateField {...props} />;
    case FieldType.Link:
      return <LinkField {...props} />;
    default:
      return <DataField {...props} />;
  }
}

export function TableField({ field, value, onChange, disabled }: FieldProps) {
  const childMeta = useDocTypeMeta(field.options ?? "");
  const rows = (value as Row[]) ?? [];
  const cols = (childMeta.data?.fields ?? []).filter(
    (f) => f.in_list_view && (f.fieldtype as FieldType) !== FieldType.Table,
  );

  function update(idx: number, fieldname: string, v: unknown) {
    const next = rows.map((r, i) => (i === idx ? { ...r, [fieldname]: v } : r));
    onChange(next);
  }
  function addRow() {
    onChange([...rows, {}]);
  }
  function removeRow(idx: number) {
    onChange(rows.filter((_, i) => i !== idx));
  }

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="w-8 px-2 py-2" />
            {cols.map((c) => (
              <th key={c.fieldname} className="px-2 py-2 text-left font-medium">
                {c.label ?? c.fieldname}
              </th>
            ))}
            <th className="w-10 px-2 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length + 2} className="px-3 py-3 text-slate-400">
                No rows.
              </td>
            </tr>
          )}
          {rows.map((row, idx) => (
            <tr key={idx} className="border-t border-slate-100">
              <td className="px-2 py-1 text-center text-slate-400">{idx + 1}</td>
              {cols.map((c) => (
                <td key={c.fieldname} className="px-2 py-1">
                  <Cell
                    field={c}
                    value={row[c.fieldname]}
                    onChange={(v) => update(idx, c.fieldname, v)}
                  />
                </td>
              ))}
              <td className="px-2 py-1 text-center">
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  disabled={disabled}
                  className="text-red-500 hover:text-red-700"
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="p-2 bg-slate-50 border-t border-slate-100">
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="text-sm text-brand-600 hover:text-brand-700 font-medium"
        >
          + Add Row
        </button>
      </div>
    </div>
  );
}
