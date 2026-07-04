"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, API_URL } from "@/lib/api-client";
import { useRefDocs, useAddComment } from "@/lib/meta-client";

type Tab = "comments" | "attachments" | "history";

export function ActivityPanel({ doctype, name }: { doctype: string; name: string }) {
  const [tab, setTab] = useState<Tab>("comments");
  const comments = useRefDocs("Comment", doctype, name);
  const files = useRefDocs("File", doctype, name);
  const versions = useRefDocs("Version", doctype, name);
  const addComment = useAddComment(doctype, name);
  const qc = useQueryClient();
  const [text, setText] = useState("");

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    fd.append("ref_doctype", doctype);
    fd.append("ref_name", name);
    await api.upload("/api/upload", fd);
    qc.invalidateQueries({ queryKey: ["File", doctype, name] });
    e.target.value = "";
  }

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "comments", label: "Comments", count: comments.data?.data.length ?? 0 },
    { key: "attachments", label: "Attachments", count: files.data?.data.length ?? 0 },
    { key: "history", label: "History", count: versions.data?.data.length ?? 0 },
  ];

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4">
      <div className="flex gap-4 border-b border-slate-100 mb-3">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`pb-2 text-sm ${tab === t.key ? "border-b-2 border-brand-600 text-brand-700 font-medium" : "text-slate-500"}`}
          >
            {t.label} <span className="text-slate-400">({t.count})</span>
          </button>
        ))}
      </div>

      {tab === "comments" && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Add a comment…"
              className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
            <button
              onClick={async () => {
                if (!text.trim()) return;
                await addComment.mutateAsync(text.trim());
                setText("");
              }}
              className="rounded-lg bg-brand-600 text-white px-3 py-1.5 text-sm"
            >
              Post
            </button>
          </div>
          {(comments.data?.data ?? []).map((c) => (
            <div key={String(c.name)} className="text-sm border-b border-slate-50 pb-2">
              <span className="text-slate-700">{String(c.content)}</span>
              <span className="block text-xs text-slate-400">{String(c.owner)}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "attachments" && (
        <div className="space-y-2">
          <input type="file" onChange={onUpload} className="text-sm" />
          {(files.data?.data ?? []).map((f) => (
            <a
              key={String(f.name)}
              href={`${API_URL}${String(f.file_url)}`}
              target="_blank"
              rel="noreferrer"
              className="block text-sm text-brand-600 hover:underline"
            >
              {String(f.file_name)}
            </a>
          ))}
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-2">
          {(versions.data?.data ?? []).map((v) => {
            let changed: string[] = [];
            try {
              changed = JSON.parse(String(v.data)).changed ?? [];
            } catch {
              /* ignore */
            }
            return (
              <div key={String(v.name)} className="text-sm border-b border-slate-50 pb-1">
                <span className="text-slate-600">Changed: {changed.join(", ") || "—"}</span>
                <span className="block text-xs text-slate-400">
                  {String(v.owner)} · {String(v.creation).slice(0, 19).replace("T", " ")}
                </span>
              </div>
            );
          })}
          {(versions.data?.data ?? []).length === 0 && (
            <p className="text-sm text-slate-400">No history yet.</p>
          )}
        </div>
      )}
    </div>
  );
}
