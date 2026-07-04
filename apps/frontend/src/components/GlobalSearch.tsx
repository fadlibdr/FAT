"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSearch } from "@/lib/meta-client";

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const { data } = useSearch(q);
  const router = useRouter();
  const hits = data?.data ?? [];

  function go(doctype: string, name: string) {
    setQ("");
    setOpen(false);
    router.push(`/app/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
  }

  return (
    <div className="relative w-72">
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search everything…"
        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
      />
      {open && hits.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {hits.map((h) => (
            <button
              key={`${h.doctype}:${h.name}`}
              onMouseDown={() => go(h.doctype, h.name)}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50"
            >
              <span className="text-slate-700">{h.title}</span>
              <span className="block text-xs text-slate-400">
                {h.doctype} · {h.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
