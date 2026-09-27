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

/** ADR-024/BUG-033: the OAuth connector and both resumable-upload endpoints (open session / confirm) are parent-only, same as every "Мої книги" screen. */
test.describe("Google Drive upload connector without a session (NFR-PRIV-4, ADR-024)", () => {
  test("/api/google/drive/connect sends the visitor to the login screen", async ({ request }) => {
    const res = await request.get("/api/google/drive/connect", { maxRedirects: 0 });
    expect([303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"] ?? "").toMatch(/\/login/);
  });

  test("/api/google/drive/callback sends the visitor to the login screen", async ({ request }) => {
    const res = await request.get("/api/google/drive/callback?code=x&state=y", { maxRedirects: 0 });
    expect([303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"] ?? "").toMatch(/\/login/);
  });

  test("POST /api/parent/books/upload (open a resumable session) sends the visitor to the login screen (no session, no secret leaked)", async ({ request }) => {
    const res = await request.post("/api/parent/books/upload", {
      maxRedirects: 0,
      headers: { "content-type": "application/json" },
      data: { fileName: "book.pdf", mimeType: "application/pdf", size: 1234 },
    });
    expect([303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"] ?? "").toMatch(/\/login/);
  });

  test("POST /api/parent/books/upload/complete sends the visitor to the login screen (no session, no secret leaked)", async ({ request }) => {
    const res = await request.post("/api/parent/books/upload/complete", {
      maxRedirects: 0,
      headers: { "content-type": "application/json" },
      data: { driveFileId: "NotARealDriveFileId0123" },
    });
    expect([303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"] ?? "").toMatch(/\/login/);
  });
});
