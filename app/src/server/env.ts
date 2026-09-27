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

/**
 * Why `getPinPepper()` would return null (BUG-005): lets callers log or show
 * a specific reason instead of a generic "something went wrong". The value
 * itself is never included.
 */
export function pinPepperIssue(): "missing" | "too_short" | null {
  const pepper = process.env.PIN_PEPPER;
  if (!pepper || !pepper.trim()) return "missing";
  return pepper.length >= 16 ? null : "too_short";
}

export function getPinPepper(): string | null {
  const pepper = process.env.PIN_PEPPER;
  return pinPepperIssue() === null ? (pepper as string) : null;
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
    | "CRON_SECRET"
    // ADR-024: shared OAuth `drive.file` connector (book upload + future D-67 archive).
    | "GOOGLE_OAUTH_CLIENT_ID"
    | "GOOGLE_OAUTH_CLIENT_SECRET"
    // S4 (ADR-010): urgent e-mail (Resend) + Telegram bot.
    | "RESEND_API_KEY"
    | "ALERT_EMAIL_TO"
    | "ALERT_EMAIL_FROM"
    | "TELEGRAM_BOT_TOKEN"
    | "TELEGRAM_WEBHOOK_SECRET"
    | "APP_BASE_URL",
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

/**
 * ADR-023 §Частина 1.5: global cap on `library.warm_topic` jobs running at
 * once (across every concurrent Vercel invocation — enforced by counting
 * `jobs` rows with `status = 'running'`, not by anything in-process). Default
 * **2** is a deliberately conservative placeholder: this environment has no
 * way to read the family's actual Anthropic/OpenAI account tier or RPM limit
 * (no billing console access, no tier info in env) — `docs/STATUS.md` asks
 * Alex to check the real per-minute limits in both provider consoles and
 * raise `LIBRARY_WARM_MAX_CONCURRENT` if they comfortably allow more before
 * relying on 2 as a long-term value.
 */
export function getLibraryWarmMaxConcurrent(): number {
  const raw = Number(process.env.LIBRARY_WARM_MAX_CONCURRENT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

/**
 * ADR-023 §Частина 1.6 (D-89, PO default accepted): daily soft cap on total
 * `ai_calls.cost_usd` tagged with a `library.warm_topic` job (`job_id is not
 * null`) — a guard against the parent marking many topics `is_current` at
 * once in one sitting, independent of the monthly 80/100/110% budget states
 * (ADR-012), which still apply to every individual call as usual.
 */
export function getLibraryWarmDailyBudgetUsd(): number {
  const raw = Number(process.env.LIBRARY_WARM_DAILY_BUDGET_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/**
 * ADR-023 §Частина 3 (D-103): a separate cap from `LIBRARY_WARM_MAX_CONCURRENT`
 * — that one limits how many warm-up jobs run *concurrently*, this one limits
 * how many topics a single "warm ahead" event (a fresh textbook's topics just
 * indexed, a subject just activated, or the child opening the next topic in
 * sequence) is allowed to enqueue at once. Without it, one indexing event for
 * a textbook with dozens of topics could enqueue jobs for all of them before
 * the daily budget check (`warmSpendTodayUsd`) ever sees the cost of the
 * first ones (it only counts calls that already happened, not queued work).
 * Default **3** — an architect hypothesis (docs/adr/023 §Частина 3), easy to
 * change via env without a migration; revisit after a few weeks of real use.
 */
export function getLibraryWarmLookaheadTopics(): number {
  const raw = Number(process.env.LIBRARY_WARM_LOOKAHEAD_TOPICS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
}
