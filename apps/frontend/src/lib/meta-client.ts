"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DocTypeMeta, FatDocument } from "@fat/shared";
import { api } from "./api-client";

export interface DocTypeListItem {
  name: string;
  module: string;
  is_submittable: boolean;
}

export function useDocTypeList() {
  return useQuery({
    queryKey: ["meta-list"],
    queryFn: () => api.get<DocTypeListItem[]>("/api/meta"),
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
