import type { UserContext } from "./permission.service";

/**
 * A super-user context for internal engine operations (event listeners posting
 * ledger entries, background jobs, etc.) that run outside an HTTP request.
 */
export function systemContext(name = "Administrator"): UserContext {
  return { name, roles: ["Administrator", "System Manager"], isSuper: true };
}
