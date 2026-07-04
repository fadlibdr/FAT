"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DocTypeMeta, FatDocument } from "@fat/shared";
import { api } from "./api-client";

export interface DocTypeListItem {
  name: string;
  module: string;
  is_submittable: boolean;
}

export function useSaveDocType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (def: unknown) => api.post<{ data: { name: string } }>("/api/admin/doctype", def),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["meta-list"] }),
  });
}

export function useGenerateApiKey() {
  return useMutation({
    mutationFn: () => api.post<{ api_key: string; api_secret: string }>("/api/auth/api-key"),
  });
}

export function useDocTypeList() {
  return useQuery({
    queryKey: ["meta-list"],
    queryFn: () => api.get<DocTypeListItem[]>("/api/meta"),
  });
}

export interface SearchHit {
  doctype: string;
  name: string;
  title: string;
}

export function useSearch(q: string) {
  return useQuery({
    queryKey: ["search", q],
    queryFn: () => api.get<{ data: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
    enabled: q.trim().length >= 2,
  });
}

export function usePrintFormat(doctype: string, name: string) {
  return useQuery({
    queryKey: ["print", doctype, name],
    queryFn: () =>
      api.get<{ data: { html: string | null } }>(
        `/api/print/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
      ),
    enabled: !!doctype && !!name && name !== "new",
  });
}

export function useDocTypeMeta(doctype: string) {
  return useQuery({
    queryKey: ["meta", doctype],
    queryFn: () => api.get<DocTypeMeta>(`/api/meta/${encodeURIComponent(doctype)}`),
    enabled: !!doctype,
  });
}

export function useDocuments(doctype: string, filters: Record<string, string> = {}) {
  const qs = new URLSearchParams(filters).toString();
  return useQuery({
    queryKey: ["docs", doctype, filters],
    queryFn: () =>
      api.get<{ data: FatDocument[] }>(
        `/api/resource/${encodeURIComponent(doctype)}${qs ? `?${qs}` : ""}`,
      ),
    enabled: !!doctype,
  });
}

export interface ReportRow {
  group: string | null;
  value: number;
}

export function useReport(
  doctype: string,
  groupBy: string,
  aggregate: "count" | "sum" = "count",
  aggregateField?: string,
) {
  const params = new URLSearchParams({ group_by: groupBy, aggregate });
  if (aggregateField) params.set("aggregate_field", aggregateField);
  return useQuery({
    queryKey: ["report", doctype, groupBy, aggregate, aggregateField],
    queryFn: () =>
      api.get<{ data: ReportRow[] }>(
        `/api/report/${encodeURIComponent(doctype)}?${params.toString()}`,
      ),
    enabled: !!doctype && !!groupBy,
  });
}

export interface QueryReportResult {
  columns: { key: string; label: string }[];
  rows: Record<string, unknown>[];
}

export function useQueryReportList() {
  return useQuery({
    queryKey: ["query-report-list"],
    queryFn: () =>
      api.get<{ data: { name: string; columns: { key: string; label: string }[] }[] }>(
        "/api/query-report",
      ),
  });
}

export function useQueryReport(name: string) {
  return useQuery({
    queryKey: ["query-report", name],
    queryFn: () => api.get<{ data: QueryReportResult }>(`/api/query-report/${name}`),
    enabled: !!name,
  });
}

export function useDocument(doctype: string, name: string) {
  return useQuery({
    queryKey: ["doc", doctype, name],
    queryFn: () =>
      api.get<{ data: FatDocument }>(
        `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
      ),
    enabled: !!doctype && !!name && name !== "new",
  });
}

export function useSaveDocument(doctype: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name?: string; data: Record<string, unknown> }) => {
      const base = `/api/resource/${encodeURIComponent(doctype)}`;
      return payload.name
        ? api.put<{ data: FatDocument }>(`${base}/${encodeURIComponent(payload.name)}`, payload.data)
        : api.post<{ data: FatDocument }>(base, payload.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["docs", doctype] });
    },
  });
}

export function useDeleteDocument(doctype: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.del<{ data: { name: string } }>(
        `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["docs", doctype] }),
  });
}

export function useWorkflowActions(doctype: string, name: string) {
  return useQuery({
    queryKey: ["workflow", doctype, name],
    queryFn: () =>
      api.get<{ state: string | null; actions: string[] }>(
        `/api/workflow/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}/actions`,
      ),
    enabled: !!doctype && !!name && name !== "new",
  });
}

export function useApplyWorkflowAction(doctype: string, name: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: string) =>
      api.post(`/api/workflow/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}/action`, {
        action,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflow", doctype, name] });
      qc.invalidateQueries({ queryKey: ["doc", doctype, name] });
    },
  });
}

export function useRefDocs(child: string, refDoctype: string, refName: string) {
  return useQuery({
    queryKey: [child, refDoctype, refName],
    queryFn: () =>
      api.get<{ data: FatDocument[] }>(
        `/api/resource/${encodeURIComponent(child)}?ref_doctype=${encodeURIComponent(refDoctype)}&ref_name=${encodeURIComponent(refName)}`,
      ),
    enabled: !!refName && refName !== "new",
  });
}

export function useAddComment(refDoctype: string, refName: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      api.post("/api/resource/Comment", { ref_doctype: refDoctype, ref_name: refName, content }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["Comment", refDoctype, refName] }),
  });
}

export function useDocAction(doctype: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, action }: { name: string; action: "submit" | "cancel" }) =>
      api.post<{ data: FatDocument }>(
        `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}/${action}`,
      ),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ["doc", doctype, vars.name] });
      qc.invalidateQueries({ queryKey: ["docs", doctype] });
    },
  });
}
