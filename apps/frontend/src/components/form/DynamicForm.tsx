"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { DocTypeMeta, FatDocument } from "@fat/shared";
import { FieldType } from "@fat/shared";
import { renderField } from "./fields";
import { useSaveDocument, useDeleteDocument, useDocAction } from "@/lib/meta-client";
import { ApiError } from "@/lib/api-client";

interface Props {
  meta: DocTypeMeta;
  doc: FatDocument | null; // null = new document
}

function initialValues(meta: DocTypeMeta, doc: FatDocument | null) {
  const values: Record<string, unknown> = {};
  for (const f of meta.fields) {
    if ((f.fieldtype as FieldType) === FieldType.Table) {
      values[f.fieldname] = doc?.[f.fieldname] ?? [];
    } else if (doc && doc[f.fieldname] !== undefined) {
      values[f.fieldname] = doc[f.fieldname];
    } else if (f.default !== undefined) {
      values[f.fieldname] = f.default;
    }
  }
  return values;
}

export function DynamicForm({ meta, doc }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialValues(meta, doc),
  );
  const [error, setError] = useState<string | null>(null);

  const save = useSaveDocument(meta.name);
  const del = useDeleteDocument(meta.name);
  const action = useDocAction(meta.name);

  const isNew = !doc;
  const docstatus = (doc?.docstatus as number) ?? 0;
  const submitted = docstatus === 1;
  const cancelled = docstatus === 2;
  const readOnly = submitted || cancelled;

  const visibleFields = useMemo(
    () => meta.fields.filter((f) => !f.hidden),
    [meta.fields],
  );

  function setField(name: string, v: unknown) {
    setValues((prev) => ({ ...prev, [name]: v }));
  }

  async function onSave() {
    setError(null);
    try {
      const res = await save.mutateAsync({
        name: doc?.name,
        data: values,
      });
      if (isNew) {
        router.push(`/app/${encodeURIComponent(meta.name)}/${encodeURIComponent(res.data.name)}`);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    }
  }

  async function onDelete() {
    if (!doc) return;
    if (!confirm(`Delete ${meta.name} ${doc.name}?`)) return;
    try {
      await del.mutateAsync(doc.name);
      router.push(`/app/${encodeURIComponent(meta.name)}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onAction(kind: "submit" | "cancel") {
    if (!doc) return;
    setError(null);
    try {
      await action.mutateAsync({ name: doc.name, action: kind });
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">
            {isNew ? `New ${meta.name}` : doc?.name}
          </h1>
          {!isNew && (
            <span
              className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full ${
                submitted
                  ? "bg-green-100 text-green-700"
                  : cancelled
                    ? "bg-red-100 text-red-700"
                    : "bg-slate-100 text-slate-600"
              }`}
            >
              {submitted ? "Submitted" : cancelled ? "Cancelled" : "Draft"}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          {!readOnly && meta.permissions.write && (
            <button
              onClick={onSave}
              disabled={save.isPending}
              className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          )}
          {!isNew && meta.is_submittable && !submitted && !cancelled && meta.permissions.submit && (
            <button
              onClick={() => onAction("submit")}
              className="rounded-lg bg-green-600 text-white px-4 py-2 text-sm font-medium hover:bg-green-700"
            >
              Submit
            </button>
          )}
          {!isNew && meta.is_submittable && submitted && meta.permissions.cancel && (
            <button
              onClick={() => onAction("cancel")}
              className="rounded-lg border border-red-300 text-red-600 px-4 py-2 text-sm font-medium hover:bg-red-50"
            >
              Cancel
            </button>
          )}
          {!isNew && !readOnly && meta.permissions.delete && (
            <button
              onClick={onDelete}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 p-6 space-y-5">
        {visibleFields.map((field) => {
          const ft = field.fieldtype as FieldType;
          if (ft === FieldType.SectionBreak || ft === FieldType.ColumnBreak) {
            return field.label ? (
              <h3
                key={field.fieldname}
                className="text-sm font-semibold text-slate-400 uppercase tracking-wide pt-2"
              >
                {field.label}
              </h3>
            ) : null;
          }
          if (ft === FieldType.Check) {
            return (
              <div key={field.fieldname}>
                {renderField(field, values[field.fieldname], (v) => setField(field.fieldname, v), readOnly)}
              </div>
            );
          }
          return (
            <div key={field.fieldname} className="space-y-1">
              <label className="text-sm font-medium text-slate-600">
                {field.label ?? field.fieldname}
                {field.reqd && <span className="text-red-500"> *</span>}
              </label>
              {renderField(field, values[field.fieldname], (v) => setField(field.fieldname, v), readOnly)}
              {field.description && (
                <p className="text-xs text-slate-400">{field.description}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
