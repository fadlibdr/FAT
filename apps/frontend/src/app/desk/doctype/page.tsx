"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FieldType } from "@fat/shared";
import { useSaveDocType } from "@/lib/meta-client";

interface FieldRow {
  fieldname: string;
  label: string;
  fieldtype: string;
  options: string;
  reqd: boolean;
  in_list_view: boolean;
}

const FIELD_TYPES = Object.values(FieldType);

export default function DoctypeBuilderPage() {
  const router = useRouter();
  const save = useSaveDocType();
  const [name, setName] = useState("");
  const [module, setModule] = useState("Custom");
  const [naming, setNaming] = useState("hash");
  const [isSubmittable, setIsSubmittable] = useState(false);
  const [fields, setFields] = useState<FieldRow[]>([
    { fieldname: "title", label: "Title", fieldtype: "Data", options: "", reqd: true, in_list_view: true },
  ]);
  const [error, setError] = useState<string | null>(null);

  function setField(i: number, patch: Partial<FieldRow>) {
    setFields((f) => f.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  }

  async function onSave() {
    setError(null);
    try {
      const def = {
        name,
        module,
        naming_rule: naming,
        is_submittable: isSubmittable,
        fields: fields.filter((f) => f.fieldname),
        permissions: [
          { role: "System Manager", read: 1, write: 1, create: 1, delete: 1, report: 1 },
        ],
      };
      const res = await save.mutateAsync(def);
      router.push(`/app/${encodeURIComponent(res.data.name)}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold mb-1">DocType Builder</h1>
      <p className="text-slate-500 text-sm mb-4">
        Create a new business object. Its table and API are provisioned instantly.
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-2">
          {error}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="e.g. Project" />
          </label>
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Module</span>
            <input value={module} onChange={(e) => setModule(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Naming</span>
            <input value={naming} onChange={(e) => setNaming(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="hash | field:title | series:PROJ-.#####" />
          </label>
          <label className="text-sm flex items-end gap-2 pb-2">
            <input type="checkbox" checked={isSubmittable} onChange={(e) => setIsSubmittable(e.target.checked)} className="h-4 w-4" />
            <span className="text-slate-600">Submittable</span>
          </label>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-medium text-sm">Fields</h3>
            <button
              onClick={() => setFields((f) => [...f, { fieldname: "", label: "", fieldtype: "Data", options: "", reqd: false, in_list_view: false }])}
              className="text-sm text-brand-600 font-medium"
            >
              + Add Field
            </button>
          </div>
          <div className="space-y-2">
            {fields.map((row, i) => (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <input placeholder="fieldname" value={row.fieldname} onChange={(e) => setField(i, { fieldname: e.target.value })} className="col-span-3 rounded border border-slate-300 px-2 py-1 text-sm" />
                <input placeholder="Label" value={row.label} onChange={(e) => setField(i, { label: e.target.value })} className="col-span-3 rounded border border-slate-300 px-2 py-1 text-sm" />
                <select value={row.fieldtype} onChange={(e) => setField(i, { fieldtype: e.target.value })} className="col-span-2 rounded border border-slate-300 px-2 py-1 text-sm">
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
                <input placeholder="options" value={row.options} onChange={(e) => setField(i, { options: e.target.value })} className="col-span-2 rounded border border-slate-300 px-2 py-1 text-sm" />
                <label className="col-span-1 text-xs flex items-center gap-1"><input type="checkbox" checked={row.reqd} onChange={(e) => setField(i, { reqd: e.target.checked })} />req</label>
                <label className="col-span-1 text-xs flex items-center gap-1"><input type="checkbox" checked={row.in_list_view} onChange={(e) => setField(i, { in_list_view: e.target.checked })} />list</label>
              </div>
            ))}
          </div>
        </div>

        <button onClick={onSave} disabled={save.isPending || !name} className="rounded-lg bg-brand-600 text-white px-4 py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
          {save.isPending ? "Creating…" : "Create DocType"}
        </button>
      </div>
    </div>
  );
}
