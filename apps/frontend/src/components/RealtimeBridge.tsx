"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "@/lib/api-client";

/**
 * Opens a Server-Sent Events stream of document changes and live-invalidates the
 * matching React Query caches so list/form views refresh without polling.
 */
export function RealtimeBridge() {
  const qc = useQueryClient();
  useEffect(() => {
    if (typeof window === "undefined") return;
    const es = new EventSource(`${API_URL}/api/stream`);
    es.onmessage = (e) => {
      try {
        const { doctype, name } = JSON.parse(e.data);
        if (doctype) {
          qc.invalidateQueries({ queryKey: ["docs", doctype] });
          if (name) qc.invalidateQueries({ queryKey: ["doc", doctype, name] });
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      /* EventSource auto-reconnects */
    };
    return () => es.close();
  }, [qc]);
  return null;
}
