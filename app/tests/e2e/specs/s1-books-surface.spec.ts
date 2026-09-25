import { expect, test } from "@playwright/test";

/**
 * S1 checks that need no accounts: "Мої книги" and the Drive link are never
 * reachable without a parent session, and the background tick endpoint is
 * protected by CRON_SECRET (ADR-015, NFR-PRIV-8).
 */
const BOOK_PAGES = [
  "/parent/books",
  "/parent/books/add",
  "/parent/books/drive",
  "/parent/books/00000000-0000-4000-8000-000000000000",
];

test.describe("Мої книги without a session (NFR-PRIV-4)", () => {
  for (const path of BOOK_PAGES) {
    test(`${path} sends the visitor to the login screen`, async ({ request }) => {
      const res = await request.get(path, { maxRedirects: 0 });
      expect([303, 307, 308]).toContain(res.status());
      const location = res.headers()["location"] ?? "";
      expect(location).toMatch(/\/login/);
      expect(location).not.toContain("drive.google.com");
    });
  }
});

test.describe("Background tick endpoint (ADR-015)", () => {
  test("rejects calls without the bearer secret", async ({ request }) => {
    expect((await request.get("/api/jobs/tick")).status()).toBe(401);
    expect((await request.post("/api/jobs/tick", { headers: { authorization: "Bearer wrong" } })).status()).toBe(401);
    expect((await request.get("/api/jobs/tick?sync=1", { headers: { authorization: "e2e-cron-secret-placeholder" } })).status()).toBe(401);
  });
});
