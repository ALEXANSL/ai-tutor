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

/** Optional server secret by name (S1+): trimmed value or null. Never log the value. */
export function getServerSecret(
  name:
    | "ANTHROPIC_API_KEY"
    | "OPENAI_API_KEY"
    | "GOOGLE_API_KEY"
    | "GOOGLE_SERVICE_ACCOUNT_JSON"
    | "CRON_SECRET",
): string | null {
  return process.env[name]?.trim() || null;
}

export interface GoogleServiceAccount {
  clientEmail: string;
  privateKey: string;
  tokenUri: string;
}

/**
 * Parses GOOGLE_SERVICE_ACCOUNT_JSON (the whole JSON key file, docs/03 1.5 step 9).
 * Returns null when missing or malformed — the caller shows "not configured".
 */
export function parseServiceAccount(raw: string | null | undefined): GoogleServiceAccount | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as { client_email?: unknown; private_key?: unknown; token_uri?: unknown };
    if (typeof json.client_email !== "string" || typeof json.private_key !== "string") return null;
    return {
      clientEmail: json.client_email,
      // Some UIs store the key with literal "\n" sequences.
      privateKey: json.private_key.replace(/\\n/g, "\n"),
      tokenUri: typeof json.token_uri === "string" ? json.token_uri : "https://oauth2.googleapis.com/token",
    };
  } catch {
    return null;
  }
}

export function getGoogleServiceAccount(): GoogleServiceAccount | null {
  return parseServiceAccount(getServerSecret("GOOGLE_SERVICE_ACCOUNT_JSON"));
}
