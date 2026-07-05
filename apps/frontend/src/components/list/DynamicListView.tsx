"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import type { DocTypeMeta } from "@fat/shared";
import { FieldType } from "@fat/shared";
import { useDocuments } from "@/lib/meta-client";
import { api } from "@/lib/api-client";

export function DynamicListView({ meta }: { meta: DocTypeMeta }) {
  const storageKey = `fat_filters_${meta.name}`;
  const [filters, setFilters] = useState<Record<string, string>>({});

  // Persist filters per DocType (a lightweight "saved view").
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      try {
        setFilters(JSON.parse(saved));
      } catch {
        /* ignore */
      }
    }
  }, [storageKey]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, JSON.stringify(filters));
  }, [storageKey, filters]);
  const { data, isLoading, error } = useDocuments(meta.name, filters);
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  async function onExport() {
    const res = await api.get<{ data: { csv: string; filename: string } }>(
      `/api/resource/${encodeURIComponent(meta.name)}/export`,
    );
    const blob = new Blob([res.data.csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.data.filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const csv = await file.text();
    const res = await api.post<{ data: { created: number; errors: unknown[] } }>(
      `/api/resource/${encodeURIComponent(meta.name)}/import`,
      { csv },
    );
    alert(`Imported ${res.data.created} row(s), ${res.data.errors.length} error(s).`);
    qc.invalidateQueries({ queryKey: ["docs", meta.name] });
    if (fileRef.current) fileRef.current.value = "";
  }

  const columns = meta.fields.filter(
    (f) => f.in_list_view && (f.fieldtype as FieldType) !== FieldType.Table,
  );
  const filterFields = meta.fields.filter((f) => f.in_standard_filter);
  const rows = data?.data ?? [];

  function setFilter(fieldname: string, value: string) {
    setFilters((prev) => {
      const next = { ...prev };
      if (value) next[fieldname] = value;
      else delete next[fieldname];
      return next;
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">{meta.name}</h1>
        <div className="flex items-center gap-2">
          <Link
            href={`/app/${encodeURIComponent(meta.name)}/kanban`}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
          >
            Kanban
          </Link>
          <Link
            href={`/app/${encodeURIComponent(meta.name)}/calendar`}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
          >
            Calendar
          </Link>
          <button onClick={onExport} className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
            Export
          </button>
          {meta.permissions.create && (
            <>
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
              >
                Import
              </button>
              <input ref={fileRef} type="file" accept=".csv" onChange={onImport} className="hidden" />
            </>
          )}
          {meta.permissions.report && (
            <Link
              href={`/report/${encodeURIComponent(meta.name)}`}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50"
            >
              Report
            </Link>
          )}
          {meta.permissions.create && (
            <Link
              href={`/app/${encodeURIComponent(meta.name)}/new`}
              className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700"
            >
              + New {meta.name}
            </Link>
          )}
        </div>
      </div>

      {filterFields.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-4">
          {filterFields.map((f) => (
            <input
              key={f.fieldname}
              placeholder={`Filter by ${f.label ?? f.fieldname}`}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
              value={filters[f.fieldname] ?? ""}
              onChange={(e) => setFilter(f.fieldname, e.target.value)}
            />
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Name</th>
              {columns.map((c) => (
                <th key={c.fieldname} className="px-4 py-3 text-left font-medium">
                  {c.label ?? c.fieldname}
                </th>
              ))}
              {meta.is_submittable && (
                <th className="px-4 py-3 text-left font-medium">Status</th>
              )}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={columns.length + 2} className="px-4 py-6 text-slate-400">
                  Loading…
                </td>
              </tr>
            )}
            {error && (
              <tr>
                <td colSpan={columns.length + 2} className="px-4 py-6 text-red-500">
                  {(error as Error).message}
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="px-4 py-6 text-slate-400">
                  No {meta.name} records yet.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr key={String(row.name)} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/app/${encodeURIComponent(meta.name)}/${encodeURIComponent(String(row.name))}`}
                    className="text-brand-600 hover:underline font-medium"
                  >
                    {String(row.name)}
                  </Link>
                </td>
                {columns.map((c) => (
                  <td key={c.fieldname} className="px-4 py-3 text-slate-600">
                    {formatCell(row[c.fieldname], c.fieldtype as FieldType)}
                  </td>
                ))}
                {meta.is_submittable && (
                  <td className="px-4 py-3">
                    <StatusBadge docstatus={(row.docstatus as number) ?? 0} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatCell(value: unknown, fieldtype: FieldType): string {
  if (value === null || value === undefined || value === "") return "";
  if (fieldtype === FieldType.Check) return value === 1 || value === "1" ? "Yes" : "";
  if (
    fieldtype === FieldType.Currency ||
    fieldtype === FieldType.Float ||
    fieldtype === FieldType.Int
  ) {
    const n = Number(value);
    return Number.isNaN(n)
      ? String(value)
      : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (fieldtype === FieldType.Date) return String(value).slice(0, 10);
  if (fieldtype === FieldType.Datetime) return String(value).replace("T", " ").slice(0, 16);
  return String(value);
}

function StatusBadge({ docstatus }: { docstatus: number }) {
  const label = docstatus === 1 ? "Submitted" : docstatus === 2 ? "Cancelled" : "Draft";
  const cls =
    docstatus === 1
      ? "bg-green-100 text-green-700"
      : docstatus === 2
        ? "bg-red-100 text-red-700"
        : "bg-slate-100 text-slate-600";
  return <span className={`text-xs px-2 py-0.5 rounded-full ${cls}`}>{label}</span>;
}
