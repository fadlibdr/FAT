import { config as loadDotenv } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Central environment configuration. Reads from process.env, loading the repo
 * root `.env` on first access so both the Nest app and standalone scripts pick
 * up the same configuration regardless of working directory.
 */
let dotenvLoaded = false;
function ensureDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  for (const candidate of [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(__dirname, "../../../.env"),
  ]) {
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
  }
}
export interface AppConfig {
  database: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
  };
  backendPort: number;
  jwt: {
    secret: string;
    accessExpires: string;
    refreshExpires: string;
  };
  admin: {
    email: string;
    password: string;
  };
}

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
}

export function loadConfig(): AppConfig {
  ensureDotenv();
  return {
    database: {
      host: env("DATABASE_HOST", "localhost"),
      port: Number(env("DATABASE_PORT", "5432")),
      user: env("DATABASE_USER", "fat"),
      password: env("DATABASE_PASSWORD", "fat"),
      name: env("DATABASE_NAME", "fat"),
    },
    backendPort: Number(env("BACKEND_PORT", "3001")),
    jwt: {
      secret: env("JWT_SECRET", "dev-secret-change-me"),
      accessExpires: env("JWT_ACCESS_EXPIRES", "1h"),
      refreshExpires: env("JWT_REFRESH_EXPIRES", "7d"),
    },
    admin: {
      email: env("ADMIN_EMAIL", "admin@example.com"),
      password: env("ADMIN_PASSWORD", "admin"),
    },
  };
}
