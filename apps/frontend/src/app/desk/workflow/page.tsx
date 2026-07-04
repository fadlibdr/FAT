"use client";

import Link from "next/link";
import { useDocuments, useDocument } from "@/lib/meta-client";

function WorkflowCard({ name }: { name: string }) {
  const { data } = useDocument("Workflow", name);
  const doc = data?.data;
  if (!doc) return null;
  const states = (doc.states as Array<Record<string, unknown>>) ?? [];
  const transitions = (doc.transitions as Array<Record<string, unknown>>) ?? [];

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold">{String(doc.workflow_name)}</h3>
          <p className="text-xs text-slate-400">for {String(doc.document_type)}</p>
        </div>
        <Link href={`/app/Workflow/${encodeURIComponent(name)}`} className="text-sm text-brand-600 hover:underline">
          Edit
        </Link>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {states.map((s) => (
          <span
            key={String(s.name)}
            className={`px-3 py-1 rounded-full text-sm ${
              String(s.doc_status) === "1"
                ? "bg-green-100 text-green-700"
                : String(s.doc_status) === "2"
                  ? "bg-red-100 text-red-700"
                  : "bg-slate-100 text-slate-600"
            }`}
          >
            {String(s.state)}
          </span>
        ))}
      </div>

      <div className="space-y-1">
        {transitions.map((t) => (
          <div key={String(t.name)} className="flex items-center gap-2 text-sm">
            <span className="px-2 py-0.5 rounded bg-slate-100">{String(t.state)}</span>
            <span className="text-slate-400">—</span>
            <span className="px-2 py-0.5 rounded bg-brand-50 text-brand-700 font-medium">{String(t.action)}</span>
            <span className="text-slate-400">→</span>
            <span className="px-2 py-0.5 rounded bg-slate-100">{String(t.next_state)}</span>
            {t.allowed ? <span className="text-xs text-slate-400">({String(t.allowed)})</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function WorkflowDesignerPage() {
  const { data, isLoading } = useDocuments("Workflow");
  const workflows = data?.data ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Workflow Designer</h1>
          <p className="text-slate-500 text-sm">State machines that gate document submission.</p>
        </div>
        <Link href="/app/Workflow/new" className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700">
          + New Workflow
        </Link>
      </div>
      {isLoading && <p className="text-slate-400">Loading…</p>}
      {!isLoading && workflows.length === 0 && <p className="text-slate-400">No workflows yet.</p>}
      {workflows.map((w) => (
        <WorkflowCard key={String(w.name)} name={String(w.name)} />
      ))}
    </div>
  );
}
