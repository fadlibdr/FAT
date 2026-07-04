"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { FieldType } from "@fat/shared";
import { useDocTypeMeta, useReport } from "@/lib/meta-client";

export default function ReportPage({ params }: { params: { doctype: string } }) {
  const doctype = decodeURIComponent(params.doctype);
  const { data: meta } = useDocTypeMeta(doctype);

  const groupable = (meta?.fields ?? []).filter((f) =>
    [FieldType.Select, FieldType.Link, FieldType.Data, FieldType.Check].includes(
      f.fieldtype as FieldType,
    ),
  );
  const numeric = (meta?.fields ?? []).filter((f) =>
    [FieldType.Currency, FieldType.Float, FieldType.Int].includes(
      f.fieldtype as FieldType,
    ),
  );

  const [groupBy, setGroupBy] = useState("");
  const [aggregate, setAggregate] = useState<"count" | "sum">("count");
  const [aggregateField, setAggregateField] = useState("");

  useEffect(() => {
    if (!groupBy && groupable.length) setGroupBy(groupable[0].fieldname);
  }, [groupBy, groupable]);

  const { data, isLoading } = useReport(
    doctype,
    groupBy,
    aggregate,
    aggregate === "sum" ? aggregateField : undefined,
  );
  const rows = data?.data ?? [];
  const max = Math.max(1, ...rows.map((r) => r.value));

  if (!meta) return <p className="text-slate-400">Loading…</p>;

  return (
    <div className="max-w-3xl">
      <Link
        href={`/app/${encodeURIComponent(doctype)}`}
        className="text-sm text-slate-500 hover:text-brand-600 mb-3 inline-block"
      >
        ← Back to {doctype}
      </Link>
      <h1 className="text-xl font-semibold mb-4">{doctype} — Report</h1>

      <div className="flex flex-wrap gap-3 mb-6 items-end">
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Group by</span>
          <select
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
          >
            {groupable.map((f) => (
              <option key={f.fieldname} value={f.fieldname}>
                {f.label ?? f.fieldname}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-slate-500 mb-1">Measure</span>
          <select
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={aggregate}
            onChange={(e) => setAggregate(e.target.value as "count" | "sum")}
          >
            <option value="count">Count</option>
            <option value="sum">Sum</option>
          </select>
        </label>
        {aggregate === "sum" && (
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Field</span>
            <select
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={aggregateField}
              onChange={(e) => setAggregateField(e.target.value)}
            >
              <option value="">— select —</option>
              {numeric.map((f) => (
                <option key={f.fieldname} value={f.fieldname}>
                  {f.label ?? f.fieldname}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-2">
        {isLoading && <p className="text-slate-400">Loading…</p>}
        {!isLoading && rows.length === 0 && (
          <p className="text-slate-400">No data.</p>
        )}
        {rows.map((r) => (
          <div key={String(r.group)} className="flex items-center gap-3">
            <div className="w-40 shrink-0 text-sm text-slate-600 truncate">
              {r.group ?? "(empty)"}
            </div>
            <div className="flex-1 bg-slate-100 rounded h-6 overflow-hidden">
              <div
                className="bg-brand-500 h-full rounded"
                style={{ width: `${(r.value / max) * 100}%` }}
              />
            </div>
            <div className="w-20 text-right text-sm font-medium text-slate-700">
              {r.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
