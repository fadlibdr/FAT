"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useDocuments, useSaveDocument } from "@/lib/meta-client";

export function NotificationBell() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { data } = useDocuments("Notification", { user: user?.email ?? "", is_read: "0" });
  const save = useSaveDocument("Notification");
  const notes = data?.data ?? [];

  async function openNote(n: Record<string, unknown>) {
    await save.mutateAsync({ name: String(n.name), data: { is_read: 1 } });
    setOpen(false);
    if (n.ref_doctype && n.ref_name) {
      router.push(`/app/${encodeURIComponent(String(n.ref_doctype))}/${encodeURIComponent(String(n.ref_name))}`);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-md px-2 py-1 hover:bg-slate-50"
        aria-label="Notifications"
      >
        <span className="text-lg">🔔</span>
        {notes.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] rounded-full h-4 min-w-4 px-1 flex items-center justify-center">
            {notes.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg z-30">
          {notes.length === 0 && <p className="p-4 text-sm text-slate-400">No new notifications.</p>}
          {notes.map((n) => (
            <button
              key={String(n.name)}
              onClick={() => openNote(n)}
              className="block w-full text-left px-3 py-2 text-sm hover:bg-slate-50 border-b border-slate-50"
            >
              <span className="text-slate-700 font-medium">{String(n.subject)}</span>
              <span className="block text-xs text-slate-400">{String(n.message ?? "")}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
