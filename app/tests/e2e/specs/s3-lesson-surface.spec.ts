import { expect, test } from "@playwright/test";

/**
 * S3: the lesson screen needs no accounts to check that it is never
 * reachable without a session (NFR-PRIV-4) — same pattern as S1/S2. The
 * lesson is additionally father-mode-only (`requireParentAccess`, not
 * `requireChild`) until S4's safety rules are verified, so an anonymous
 * visitor is sent to the login screen exactly like every other parent route.
 *
 * Full interactive coverage (starting a lesson, answering steps, dragging
 * `drag_sort` cards by touch) needs a signed-in parent/tablet session and is
 * exercised manually on Alex's device per the demo checklist in
 * docs/STATUS.md — the same limitation noted for S0–S2's e2e specs, since
 * this environment has no real Google accounts to sign in with.
 */
const LESSON_PAGES = ["/lesson/00000000-0000-4000-8000-000000000000"];

test.describe("Урок without a session (NFR-PRIV-4)", () => {
  for (const path of LESSON_PAGES) {
    test(`${path} sends the visitor to the login screen`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([303, 307, 308]).toContain(res.status());
      expect(res.headers()["location"] ?? "").toMatch(/\/login/);
    });
  }
});

// ADR-022 / D-55: the "methodical passport" library card page — parent-only
// like every other cabinet route.
const LIBRARY_PAGES = ["/parent/library/00000000-0000-4000-8000-000000000000"];

test.describe("Бібліотека (методичний паспорт) without a session (NFR-PRIV-4)", () => {
  for (const path of LIBRARY_PAGES) {
    test(`${path} sends the visitor to the login screen`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([303, 307, 308]).toContain(res.status());
      expect(res.headers()["location"] ?? "").toMatch(/\/login/);
    });
  }
});
