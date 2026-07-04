"use client";

import { useDocTypeMeta } from "@/lib/meta-client";
import { DynamicListView } from "@/components/list/DynamicListView";

export default function ListPage({ params }: { params: { doctype: string } }) {
  const doctype = decodeURIComponent(params.doctype);
  const { data: meta, isLoading, error } = useDocTypeMeta(doctype);

  if (isLoading) return <p className="text-slate-400">Loading {doctype}…</p>;
  if (error) return <p className="text-red-500">{(error as Error).message}</p>;
  if (!meta) return null;

  return <DynamicListView meta={meta} />;
}
