"use client";

import { FieldProps, inputClass } from "./types";

export function NumberField({ field, value, onChange, disabled }: FieldProps) {
  return (
    <input
      type="number"
      step="any"
      className={inputClass}
      value={value === null || value === undefined ? "" : (value as number)}
      disabled={disabled || field.read_only}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
}
