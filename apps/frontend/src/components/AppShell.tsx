"use client";

import { useAuth } from "@/lib/auth";
import { LoginForm } from "./LoginForm";
import { Nav } from "./Nav";
import { GlobalSearch } from "./GlobalSearch";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-400">
        Loading…
      </div>
    );
  }

  if (!user) return <LoginForm />;

  return (
    <div className="flex min-h-screen">
      <Nav />
      <div className="flex-1 flex flex-col">
        <header className="h-14 border-b border-slate-200 bg-white flex items-center justify-between px-6 sticky top-0 z-10">
          <GlobalSearch />
          <div className="flex items-center gap-3 text-sm">
            <span className="text-slate-600">{user.full_name ?? user.email}</span>
            <button
              onClick={logout}
              className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
