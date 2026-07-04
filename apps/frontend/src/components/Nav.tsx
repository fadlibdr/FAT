"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useDocTypeList } from "@/lib/meta-client";

export function Nav() {
  const { data, isLoading } = useDocTypeList();
  const pathname = usePathname();

  const byModule = new Map<string, { name: string }[]>();
  for (const dt of data ?? []) {
    const list = byModule.get(dt.module) ?? [];
    list.push({ name: dt.name });
    byModule.set(dt.module, list);
  }

  return (
    <nav className="w-64 shrink-0 border-r border-slate-200 bg-white h-screen sticky top-0 overflow-y-auto">
      <div className="px-5 py-4 border-b border-slate-100">
        <Link href="/" className="text-xl font-bold text-brand-700">
          FAT
        </Link>
        <p className="text-xs text-slate-400">Modular ERP</p>
      </div>
      <div className="p-3 space-y-4">
        {isLoading && <p className="px-2 text-sm text-slate-400">Loading…</p>}
        {[...byModule.entries()].map(([module, items]) => (
          <div key={module}>
            <p className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              {module}
            </p>
            <ul className="mt-1 space-y-0.5">
              {items.map((it) => {
                const href = `/app/${encodeURIComponent(it.name)}`;
                const active = pathname === href;
                return (
                  <li key={it.name}>
                    <Link
                      href={href}
                      className={`block rounded-md px-2 py-1.5 text-sm ${
                        active
                          ? "bg-brand-50 text-brand-700 font-medium"
                          : "text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {it.name}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
