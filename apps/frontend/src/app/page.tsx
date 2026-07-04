"use client";

import Link from "next/link";
import { useDocTypeList } from "@/lib/meta-client";

export default function HomePage() {
  const { data, isLoading } = useDocTypeList();

  const byModule = new Map<string, string[]>();
  for (const dt of data ?? []) {
    const list = byModule.get(dt.module) ?? [];
    list.push(dt.name);
    byModule.set(dt.module, list);
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Welcome to FAT</h1>
      <p className="text-slate-500 mb-6">
        A metadata-driven, modular-monolith ERP. Pick a DocType to get started.
      </p>
      {isLoading && <p className="text-slate-400">Loading modules…</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...byModule.entries()].map(([module, names]) => (
          <div key={module} className="bg-white rounded-xl border border-slate-200 p-5">
            <h2 className="font-semibold text-brand-700 mb-3">{module}</h2>
            <ul className="space-y-1">
              {names.map((name) => (
                <li key={name}>
                  <Link
                    href={`/app/${encodeURIComponent(name)}`}
                    className="text-sm text-slate-600 hover:text-brand-600"
                  >
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
