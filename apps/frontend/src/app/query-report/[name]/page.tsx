"use client";

import Link from "next/link";
import { useQueryReport } from "@/lib/meta-client";

const TITLES: Record<string, string> = {
  "trial-balance": "Trial Balance",
  "stock-balance": "Stock Balance",
};

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  if (!Number.isNaN(n) && typeof v !== "boolean")
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(v);
}

export default function QueryReportPage({ params }: { params: { name: string } }) {
  const name = params.name;
  const { data, isLoading, error } = useQueryReport(name);
  const result = data?.data;

  return (
    <div className="max-w-3xl">
      <Link href="/" className="text-sm text-slate-500 hover:text-brand-600 mb-3 inline-block">
        ← Home
      </Link>
      <h1 className="text-xl font-semibold mb-4">{TITLES[name] ?? name}</h1>
      {isLoading && <p className="text-slate-400">Loading…</p>}
      {error && <p className="text-red-500">{(error as Error).message}</p>}
      {result && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                {result.columns.map((c) => (
                  <th key={c.key} className="px-4 py-3 text-left font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={result.columns.length} className="px-4 py-6 text-slate-400">
                    No data.
                  </td>
                </tr>
              )}
              {result.rows.map((row, i) => (
                <tr key={i} className="border-t border-slate-100">
                  {result.columns.map((c) => (
                    <td key={c.key} className="px-4 py-3 text-slate-700">
                      {fmt(row[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
