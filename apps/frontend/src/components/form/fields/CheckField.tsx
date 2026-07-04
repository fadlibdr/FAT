"use client";

import { FieldProps } from "./types";

export function CheckField({ field, value, onChange, disabled }: FieldProps) {
  const checked = value === 1 || value === true || value === "1";
  return (
    <label className="inline-flex items-center gap-2">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
        checked={checked}
        disabled={disabled || field.read_only}
        onChange={(e) => onChange(e.target.checked ? 1 : 0)}
      />
      <span className="text-sm text-slate-600">{field.label ?? field.fieldname}</span>
    </label>
  );
}
