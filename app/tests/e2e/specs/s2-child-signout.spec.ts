import { expect, test } from "@playwright/test";

/**
 * BUG-004: a way out of the child's account on a shared tablet, and a login
 * screen ready for a different Google account afterwards (NFR-PRIV-4).
 */
test.describe("Sign-out route (BUG-004)", () => {
  test("POST /auth/signout redirects to the login screen (account chooser on next Google sign-in)", async ({ request }) => {
    const res = await request.post("/auth/signout", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"] ?? "").toMatch(/\/login/);
  });

  test("GET /my-tutor without a session sends the visitor to the login screen, not the child UI", async ({ request }) => {
    const res = await request.get("/my-tutor", { maxRedirects: 0 });
    expect([303, 307, 308]).toContain(res.status());
    expect(res.headers()["location"] ?? "").toMatch(/\/login/);
  });
});
