"use client";

import { useState } from "react";
import Link from "next/link";
import { FieldType } from "@fat/shared";
import { useDocTypeMeta, useDocuments, useSaveDocument } from "@/lib/meta-client";

export default function KanbanPage({ params }: { params: { doctype: string } }) {
  const doctype = decodeURIComponent(params.doctype);
  const { data: meta } = useDocTypeMeta(doctype);
  const { data } = useDocuments(doctype);
  const save = useSaveDocument(doctype);
  const [dragged, setDragged] = useState<string | null>(null);

  if (!meta) return <p className="text-slate-400">Loading…</p>;

  const selectField = meta.fields.find((f) => (f.fieldtype as FieldType) === FieldType.Select);
  if (!selectField) {
    return (
      <div>
        <p className="text-slate-500">{doctype} has no Select field to group by.</p>
        <Link href={`/app/${encodeURIComponent(doctype)}`} className="text-brand-600 text-sm">← Back to list</Link>
      </div>
    );
  }
  const columns = (selectField.options ?? "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const titleField = meta.title_field ?? "name";
  const docs = data?.data ?? [];

  async function moveTo(name: string, value: string) {
    await save.mutateAsync({ name, data: { [selectField!.fieldname]: value } });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">{doctype} — Kanban</h1>
        <Link href={`/app/${encodeURIComponent(doctype)}`} className="text-sm text-slate-500 hover:text-brand-600">
          List view →
        </Link>
      </div>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {columns.map((col) => {
          const cards = docs.filter((d) => String(d[selectField.fieldname] ?? "") === col);
          return (
            <div
              key={col}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragged) moveTo(dragged, col);
                setDragged(null);
              }}
              className="w-64 shrink-0 bg-slate-100 rounded-xl p-3"
            >
              <h3 className="font-medium text-sm text-slate-600 mb-2">
                {col} <span className="text-slate-400">({cards.length})</span>
              </h3>
              <div className="space-y-2">
                {cards.map((c) => (
                  <div
                    key={String(c.name)}
                    draggable
                    onDragStart={() => setDragged(String(c.name))}
                    className="bg-white rounded-lg border border-slate-200 p-3 cursor-move"
                  >
                    <Link
                      href={`/app/${encodeURIComponent(doctype)}/${encodeURIComponent(String(c.name))}`}
                      className="text-sm text-brand-600 hover:underline"
                    >
                      {String(c[titleField] ?? c.name)}
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
