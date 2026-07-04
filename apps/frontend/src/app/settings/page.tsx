"use client";

import Link from "next/link";
import { useState } from "react";
import { API_URL } from "@/lib/api-client";
import { useGenerateApiKey } from "@/lib/meta-client";

export default function SettingsPage() {
  const gen = useGenerateApiKey();
  const [creds, setCreds] = useState<{ api_key: string; api_secret: string } | null>(null);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Developer Settings</h1>
        <p className="text-slate-500 text-sm">API keys, DocType builder and API docs.</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5">
        <h3 className="font-medium mb-2">API Key</h3>
        <p className="text-sm text-slate-500 mb-3">
          Use <code className="bg-slate-100 px-1 rounded">Authorization: token &lt;key&gt;:&lt;secret&gt;</code> for programmatic access.
        </p>
        <button
          onClick={async () => setCreds(await gen.mutateAsync())}
          className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700"
        >
          {gen.isPending ? "Generating…" : "Generate new API key"}
        </button>
        {creds && (
          <div className="mt-3 text-sm bg-amber-50 border border-amber-200 rounded-lg p-3">
            <p className="text-amber-800 mb-1">Copy your secret now — it is shown only once.</p>
            <p><b>Key:</b> <code>{creds.api_key}</code></p>
            <p><b>Secret:</b> <code>{creds.api_secret}</code></p>
          </div>
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-2">
        <h3 className="font-medium">Developer tools</h3>
        <Link href="/desk/doctype" className="block text-sm text-brand-600 hover:underline">
          DocType Builder →
        </Link>
        <a href={`${API_URL}/api/docs`} target="_blank" rel="noreferrer" className="block text-sm text-brand-600 hover:underline">
          API Documentation →
        </a>
      </div>
    </div>
  );
}
