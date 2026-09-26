import { expect, test } from "@playwright/test";

/**
 * S4: no accounts in this environment (same limitation as every other e2e
 * spec here) — this only checks that every new screen is never reachable
 * without a session (NFR-PRIV-4), same pattern as S0–S3's specs. The lesson
 * screen is no longer father-mode-only (S3's restriction is lifted now that
 * ADR-009 moderation is wired in) — it uses `requireLessonAccess()`, which
 * still redirects an anonymous visitor to /login exactly like
 * `requireParentAccess()` did.
 *
 * Full interactive coverage (a red-line phrase actually triggering
 * `safety_events` + the cabinet notification + the urgent e-mail/Telegram
 * delivery, "ШІ-друг" round-tripping, the break offer appearing after the
 * threshold) needs a signed-in session and is exercised manually on Alex's
 * device per the demo checklist in docs/STATUS.md.
 */
const NO_SESSION_PAGES = [
  "/friend",
  "/subject/00000000-0000-4000-8000-000000000000",
  "/parent/conversations",
  "/parent/settings",
];

test.describe("S4 screens without a session (NFR-PRIV-4)", () => {
  for (const path of NO_SESSION_PAGES) {
    test(`${path} sends the visitor to the login screen`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([303, 307, 308]).toContain(res.status());
      expect(res.headers()["location"] ?? "").toMatch(/\/login/);
    });
  }
});

test.describe("Telegram webhook (ADR-010)", () => {
  test("rejects a request without the secret header", async ({ request }) => {
    const res = await request.post("/api/telegram/webhook", { data: {} });
    // 503 if TELEGRAM_WEBHOOK_SECRET is unset in this environment, 401 otherwise — never 200.
    expect([401, 503]).toContain(res.status());
  });
});
