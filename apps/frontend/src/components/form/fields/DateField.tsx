"use client";

import { FieldProps, inputClass } from "./types";

export function DateField({ field, value, onChange, disabled }: FieldProps) {
  const v = value ? String(value).slice(0, 10) : "";
  return (
    <input
      type="date"
      className={inputClass}
      value={v}
      disabled={disabled || field.read_only}
      onChange={(e) => onChange(e.target.value || null)}
    />
  );
}
