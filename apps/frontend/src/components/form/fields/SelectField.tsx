"use client";

import { FieldProps, inputClass } from "./types";

export function SelectField({ field, value, onChange, disabled }: FieldProps) {
  const options = (field.options ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <select
      className={inputClass}
      value={(value as string) ?? ""}
      disabled={disabled || field.read_only}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">— Select —</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt}
        </option>
      ))}
    </select>
  );
}
