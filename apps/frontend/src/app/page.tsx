"use client";

import Link from "next/link";
import { useDocuments, useReport, useDocTypeList } from "@/lib/meta-client";

function StatCard({ label, doctype }: { label: string; doctype: string }) {
  const { data } = useDocuments(doctype);
  return (
    <Link
      href={`/app/${encodeURIComponent(doctype)}`}
      className="bg-white rounded-xl border border-slate-200 p-5 hover:border-brand-300 transition"
    >
      <div className="text-3xl font-bold text-slate-800">{data?.data.length ?? "—"}</div>
      <div className="text-sm text-slate-500 mt-1">{label}</div>
    </Link>
  );
}

function BarChart({ title, doctype, groupBy }: { title: string; doctype: string; groupBy: string }) {
  const { data } = useReport(doctype, groupBy, "count");
  const rows = data?.data ?? [];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <h3 className="font-semibold mb-3">{title}</h3>
      <div className="space-y-2">
        {rows.length === 0 && <p className="text-sm text-slate-400">No data.</p>}
        {rows.map((r) => (
          <div key={String(r.group)} className="flex items-center gap-3">
            <div className="w-28 shrink-0 text-sm text-slate-600 truncate">
              {r.group ?? "(empty)"}
            </div>
            <div className="flex-1 bg-slate-100 rounded h-5">
              <div className="bg-brand-500 h-full rounded" style={{ width: `${(r.value / max) * 100}%` }} />
            </div>
            <div className="w-8 text-right text-sm font-medium">{r.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HomePage() {
  const { data: doctypes } = useDocTypeList();
  const byModule = new Map<string, string[]>();
  for (const dt of doctypes ?? []) {
    const list = byModule.get(dt.module) ?? [];
    list.push(dt.name);
    byModule.set(dt.module, list);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-slate-500">A live view of your FAT ERP.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Customers" doctype="Customer" />
        <StatCard label="Items" doctype="Item" />
        <StatCard label="Sales Orders" doctype="Sales Order" />
        <StatCard label="Sales Invoices" doctype="Sales Invoice" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <BarChart title="Sales Orders by Customer" doctype="Sales Order" groupBy="customer" />
        <BarChart title="Sales Invoices by Status" doctype="Sales Invoice" groupBy="status" />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h3 className="font-semibold mb-3">Financial & Stock Reports</h3>
        <div className="flex gap-3 flex-wrap">
          <Link href="/query-report/trial-balance" className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
            Trial Balance
          </Link>
          <Link href="/query-report/stock-balance" className="rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50">
            Stock Balance
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[...byModule.entries()].map(([module, names]) => (
          <div key={module} className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="font-semibold text-brand-700 mb-2">{module}</h2>
            <ul className="space-y-1">
              {names.slice(0, 8).map((name) => (
                <li key={name}>
                  <Link href={`/app/${encodeURIComponent(name)}`} className="text-sm text-slate-600 hover:text-brand-600">
                    {name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
