"use client";

import { FieldProps, inputClass } from "./types";

export function DataField({ field, value, onChange, disabled }: FieldProps) {
  return (
    <input
      type="text"
      className={inputClass}
      value={(value as string) ?? ""}
      disabled={disabled || field.read_only}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function TextAreaField({ field, value, onChange, disabled }: FieldProps) {
  return (
    <textarea
      className={inputClass}
      rows={3}
      value={(value as string) ?? ""}
      disabled={disabled || field.read_only}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
