"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

interface UserRow {
  name: string;
  email: string;
  full_name: string | null;
}

export default function RbacPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [userRoles, setUserRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ data: UserRow[] }>("/api/admin/rbac/users")
      .then((r) => setUsers(r.data))
      .catch((e) => setError((e as Error).message));
    api.get<{ data: string[] }>("/api/admin/rbac/roles").then((r) => setRoles(r.data));
  }, []);

  async function loadRoles(user: string) {
    setSelected(user);
    if (!user) return setUserRoles([]);
    const r = await api.get<{ data: string[] }>(`/api/admin/rbac/user-roles/${encodeURIComponent(user)}`);
    setUserRoles(r.data);
  }

  async function toggle(role: string, has: boolean) {
    await api.post(`/api/admin/rbac/${has ? "unassign" : "assign"}`, { user: selected, role });
    await loadRoles(selected);
  }

  if (error) return <p className="text-red-500">{error}</p>;

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Roles &amp; Permissions</h1>
        <p className="text-slate-500 text-sm">Assign roles to users. (System Manager only.)</p>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
        <label className="text-sm block">
          <span className="block text-slate-500 mb-1">User</span>
          <select
            value={selected}
            onChange={(e) => loadRoles(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">— select a user —</option>
            {users.map((u) => (
              <option key={u.name} value={u.name}>
                {u.full_name ? `${u.full_name} (${u.email})` : u.email}
              </option>
            ))}
          </select>
        </label>

        {selected && (
          <div>
            <p className="text-sm font-medium mb-2">Roles</p>
            <div className="grid grid-cols-2 gap-2">
              {roles.map((role) => {
                const has = userRoles.includes(role);
                return (
                  <label key={role} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={has} onChange={() => toggle(role, has)} className="h-4 w-4" />
                    <span className={has ? "text-slate-800" : "text-slate-500"}>{role}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
