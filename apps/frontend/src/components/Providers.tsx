"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/lib/auth";
import { AppShell } from "./AppShell";
import { RealtimeBridge } from "./RealtimeBridge";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RealtimeBridge />
        <AppShell>{children}</AppShell>
      </AuthProvider>
    </QueryClientProvider>
  );
}
