"use client";

import { useId } from "react";
import { FieldProps, inputClass } from "./types";
import { useDocuments } from "@/lib/meta-client";

/**
 * Link field: a typeahead over the target DocType's records. Uses a native
 * datalist populated from the target DocType's list endpoint.
 */
export function LinkField({ field, value, onChange, disabled }: FieldProps) {
  const target = field.options ?? "";
  const listId = useId();
  const { data } = useDocuments(target);
  const rows = data?.data ?? [];

  return (
    <>
      <input
        type="text"
        list={listId}
        className={inputClass}
        value={(value as string) ?? ""}
        placeholder={`Search ${target}…`}
        disabled={disabled || field.read_only}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {rows.map((r) => (
          <option key={r.name} value={r.name}>
            {String(r.name)}
          </option>
        ))}
      </datalist>
    </>
  );
}
