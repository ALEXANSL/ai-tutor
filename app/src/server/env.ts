import "server-only";
import { parseEmailList, type Allowlist } from "./auth/allowlist";

/**
 * Server-side configuration access. Secrets are read lazily (never at import
 * time) so the app builds without any env and fails with a clear message at
 * runtime instead. Values are never logged; only variable NAMES may be shown.
 */
const REQUIRED_FOR_S0 = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ALLOWLIST_PARENT_EMAILS",
  "ALLOWLIST_CHILD_EMAILS",
  "PIN_PEPPER",
] as const;

export function missingRequiredEnv(): string[] {
  // NEXT_PUBLIC_* are inlined at build time, so they are checked via static access.
  const hasPublic = getPublicSupabaseConfig() !== null;
  return REQUIRED_FOR_S0.filter((name) =>
    name.startsWith("NEXT_PUBLIC_") ? !hasPublic : !process.env[name]?.trim(),
  );
}

export function getPublicSupabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  return url && anonKey ? { url, anonKey } : null;
}

export function requireServiceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return key;
}

export function getAllowlist(): Allowlist {
  return {
    parent: parseEmailList(process.env.ALLOWLIST_PARENT_EMAILS),
    child: parseEmailList(process.env.ALLOWLIST_CHILD_EMAILS),
  };
}

export function getPinPepper(): string | null {
  const pepper = process.env.PIN_PEPPER;
  return pepper && pepper.length >= 16 ? pepper : null;
}

/** Base URL for OAuth redirects: APP_BASE_URL, else the request origin. */
export function getAppBaseUrl(requestOrigin: string): string {
  const configured = process.env.APP_BASE_URL?.trim();
  return (configured || requestOrigin).replace(/\/+$/, "");
}
