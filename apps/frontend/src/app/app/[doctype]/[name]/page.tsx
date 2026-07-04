"use client";

import Link from "next/link";
import { useDocTypeMeta, useDocument } from "@/lib/meta-client";
import { DynamicForm } from "@/components/form/DynamicForm";

export default function FormPage({
  params,
}: {
  params: { doctype: string; name: string };
}) {
  const doctype = decodeURIComponent(params.doctype);
  const name = decodeURIComponent(params.name);
  const isNew = name === "new";

  const metaQ = useDocTypeMeta(doctype);
  const docQ = useDocument(doctype, isNew ? "" : name);

  if (metaQ.isLoading) return <p className="text-slate-400">Loading…</p>;
  if (metaQ.error) return <p className="text-red-500">{(metaQ.error as Error).message}</p>;
  if (!metaQ.data) return null;
  if (!isNew && docQ.isLoading) return <p className="text-slate-400">Loading…</p>;
  if (!isNew && docQ.error)
    return <p className="text-red-500">{(docQ.error as Error).message}</p>;

  return (
    <div>
      <Link
        href={`/app/${encodeURIComponent(doctype)}`}
        className="text-sm text-slate-500 hover:text-brand-600 mb-3 inline-block"
      >
        ← Back to {doctype}
      </Link>
      <DynamicForm meta={metaQ.data} doc={isNew ? null : docQ.data?.data ?? null} />
    </div>
  );
}
