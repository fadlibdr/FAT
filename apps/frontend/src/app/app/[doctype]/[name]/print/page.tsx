"use client";

import { useEffect } from "react";
import { FieldType } from "@fat/shared";
import { useDocTypeMeta, useDocument, usePrintFormat } from "@/lib/meta-client";

export default function PrintPage({
  params,
}: {
  params: { doctype: string; name: string };
}) {
  const doctype = decodeURIComponent(params.doctype);
  const name = decodeURIComponent(params.name);
  const { data: meta } = useDocTypeMeta(doctype);
  const { data: docRes } = useDocument(doctype, name);
  const { data: pf } = usePrintFormat(doctype, name);
  const doc = docRes?.data;
  const customHtml = pf?.data.html ?? null;

  useEffect(() => {
    if (doc && meta) {
      const t = setTimeout(() => window.print(), 400);
      return () => clearTimeout(t);
    }
  }, [doc, meta]);

  if (!meta || !doc) return <p className="text-slate-400">Loading…</p>;

  if (customHtml) {
    return (
      <div className="max-w-2xl mx-auto bg-white p-8 print:p-0">
        <div dangerouslySetInnerHTML={{ __html: customHtml }} />
        <button
          onClick={() => window.print()}
          className="print:hidden mt-4 rounded-lg bg-brand-600 text-white px-4 py-2 text-sm"
        >
          Print
        </button>
      </div>
    );
  }

  const fields = meta.fields.filter(
    (f) =>
      !f.hidden &&
      ![FieldType.SectionBreak, FieldType.ColumnBreak, FieldType.Table].includes(
        f.fieldtype as FieldType,
      ),
  );
  const tables = meta.fields.filter(
    (f) => (f.fieldtype as FieldType) === FieldType.Table,
  );

  return (
    <div className="max-w-2xl mx-auto bg-white p-8 print:p-0">
      <div className="flex justify-between items-start border-b pb-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold">{doctype}</h1>
          <p className="text-slate-500">{doc.name}</p>
        </div>
        <div className="text-right text-sm text-slate-400">FAT ERP</div>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 mb-8">
        {fields.map((f) => {
          const v = doc[f.fieldname];
          if (v === null || v === undefined || v === "") return null;
          return (
            <div key={f.fieldname}>
              <dt className="text-xs uppercase tracking-wide text-slate-400">
                {f.label ?? f.fieldname}
              </dt>
              <dd className="text-sm text-slate-800">{String(v)}</dd>
            </div>
          );
        })}
      </dl>

      {tables.map((tf) => {
        const rows = (doc[tf.fieldname] as Array<Record<string, unknown>>) ?? [];
        if (!rows.length) return null;
        const cols = Object.keys(rows[0]).filter(
          (k) =>
            ![
              "name",
              "parent",
              "parenttype",
              "parentfield",
              "owner",
              "creation",
              "modified",
              "modified_by",
              "docstatus",
              "idx",
            ].includes(k),
        );
        return (
          <div key={tf.fieldname} className="mb-6">
            <h3 className="font-semibold mb-2">{tf.label ?? tf.fieldname}</h3>
            <table className="w-full text-sm border">
              <thead className="bg-slate-50">
                <tr>
                  {cols.map((c) => (
                    <th key={c} className="border px-2 py-1 text-left">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => (
                      <td key={c} className="border px-2 py-1">
                        {String(r[c] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      <button
        onClick={() => window.print()}
        className="print:hidden mt-4 rounded-lg bg-brand-600 text-white px-4 py-2 text-sm"
      >
        Print
      </button>
    </div>
  );
}
