/**
 * Google-account allowlist (US-1.1 KP-2, KP-3; ADR-002; NFR-PRIV-8).
 * E-mails live only in environment variables; this module never logs them.
 */
export type AppRole = "parent" | "child";

export interface Allowlist {
  parent: readonly string[];
  child: readonly string[];
}

export type AllowlistDecision =
  | { ok: true; role: AppRole }
  | { ok: false; reason: "no_email" | "not_configured" | "not_listed" | "ambiguous" };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Parses a comma/semicolon/whitespace separated list of e-mails. */
export function parseEmailList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map(normalizeEmail)
        .filter((e) => e.length > 3 && e.includes("@")),
    ),
  );
}

export function resolveRole(email: string | null | undefined, allowlist: Allowlist): AllowlistDecision {
  if (allowlist.parent.length === 0 && allowlist.child.length === 0) {
    return { ok: false, reason: "not_configured" };
  }
  if (!email || !email.includes("@")) return { ok: false, reason: "no_email" };
  const normalized = normalizeEmail(email);
  const isParent = allowlist.parent.includes(normalized);
  const isChild = allowlist.child.includes(normalized);
  // Misconfiguration (same account in both lists) must never grant parent rights by accident.
  if (isParent && isChild) return { ok: false, reason: "ambiguous" };
  if (isParent) return { ok: true, role: "parent" };
  if (isChild) return { ok: true, role: "child" };
  return { ok: false, reason: "not_listed" };
}
