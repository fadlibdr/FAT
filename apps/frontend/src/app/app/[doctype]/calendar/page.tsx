"use client";

import Link from "next/link";
import { FieldType } from "@fat/shared";
import { useDocTypeMeta, useDocuments } from "@/lib/meta-client";

export default function CalendarPage({ params }: { params: { doctype: string } }) {
  const doctype = decodeURIComponent(params.doctype);
  const { data: meta } = useDocTypeMeta(doctype);
  const { data } = useDocuments(doctype);

  if (!meta) return <p className="text-slate-400">Loading…</p>;

  const dateField = meta.fields.find((f) => (f.fieldtype as FieldType) === FieldType.Date);
  if (!dateField) {
    return (
      <div>
        <p className="text-slate-500">{doctype} has no Date field to place on a calendar.</p>
        <Link href={`/app/${encodeURIComponent(doctype)}`} className="text-brand-600 text-sm">← Back to list</Link>
      </div>
    );
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startWeekday = first.getDay();
  const titleField = meta.title_field ?? "name";
  const docs = data?.data ?? [];

  const byDay = new Map<number, { name: string; title: string }[]>();
  for (const d of docs) {
    const raw = d[dateField.fieldname];
    if (!raw) continue;
    const dt = new Date(String(raw));
    if (dt.getFullYear() === year && dt.getMonth() === month) {
      const day = dt.getDate();
      const arr = byDay.get(day) ?? [];
      arr.push({ name: String(d.name), title: String(d[titleField] ?? d.name) });
      byDay.set(day, arr);
    }
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(day);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">
          {doctype} — {first.toLocaleString(undefined, { month: "long", year: "numeric" })}
        </h1>
        <Link href={`/app/${encodeURIComponent(doctype)}`} className="text-sm text-slate-500 hover:text-brand-600">
          List view →
        </Link>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="text-xs font-medium text-slate-400 text-center">{d}</div>
        ))}
        {cells.map((day, i) => (
          <div key={i} className="min-h-24 rounded-lg border border-slate-200 bg-white p-1.5">
            {day && <div className="text-xs text-slate-400 mb-1">{day}</div>}
            {day &&
              (byDay.get(day) ?? []).map((it) => (
                <Link
                  key={it.name}
                  href={`/app/${encodeURIComponent(doctype)}/${encodeURIComponent(it.name)}`}
                  className="block text-xs bg-brand-50 text-brand-700 rounded px-1 py-0.5 mb-1 truncate hover:bg-brand-100"
                >
                  {it.title}
                </Link>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
