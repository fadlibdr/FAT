import type { DocFieldDef } from "@fat/shared";

export interface FieldProps {
  field: DocFieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}

export const inputClass =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-slate-100 disabled:text-slate-500";
