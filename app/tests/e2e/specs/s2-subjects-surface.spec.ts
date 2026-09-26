import { expect, test } from "@playwright/test";

/**
 * S2 checks that need no accounts: "Предмети" (US-3.1, US-3.2) is never
 * reachable without a parent session (NFR-PRIV-4).
 */
const SUBJECT_PAGES = ["/parent/subjects", "/parent/subjects/00000000-0000-4000-8000-000000000000"];

test.describe("Предмети without a session (NFR-PRIV-4)", () => {
  for (const path of SUBJECT_PAGES) {
    test(`${path} sends the visitor to the login screen`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([303, 307, 308]).toContain(res.status());
      expect(res.headers()["location"] ?? "").toMatch(/\/login/);
    });
  }
});
