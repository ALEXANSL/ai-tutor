import { expect, test } from "@playwright/test";

/**
 * S0 smoke tests that work WITHOUT Supabase/Google accounts (see
 * playwright.config.ts). They exercise the logged-out / not-configured
 * surface on the two target devices (NFR-PLAT-1, NFR-PLAT-2) and guard
 * against secret leaks (NFR-PRIV-3, NFR-PRIV-8, NFR-PRIV-10).
 */

const SECRET_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "ALLOWLIST_PARENT_EMAILS",
  "ALLOWLIST_CHILD_EMAILS",
  "PIN_PEPPER",
  "TELEGRAM_BOT_TOKEN",
  "RESEND_API_KEY",
  "GOOGLE_DRIVE_FOLDER_ID",
];

test.describe("Login screen (US-1.1)", () => {
  test("renders the Google sign-in button and only variable NAMES for missing config", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: /Увійти через Google/i })).toBeVisible();

    // Config-missing banner must show variable NAMES, never real values.
    const body = await page.content();
    for (const name of SECRET_NAMES) {
      // The name itself may legitimately appear (as a hint); a VALUE never should.
      expect(body).not.toMatch(new RegExp(`${name}=\\S`));
    }
  });

  test("does not overflow the viewport on either target device", async ({ page }) => {
    await page.goto("/login");
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  });

  test("posts to /auth/login to start Google OAuth (no client-side secret)", async ({ page }) => {
    await page.goto("/login");
    const form = page.locator("form[action='/auth/login']");
    await expect(form).toHaveAttribute("method", "post");
  });
});

test.describe("No secrets in delivered HTML/JS (NFR-PRIV-3, defence in depth)", () => {
  test("home, login and offline pages carry no secret variable values", async ({ request }) => {
    for (const path of ["/", "/login", "/offline", "/denied", "/no-access"]) {
      const res = await request.get(path);
      const text = await res.text();
      for (const name of SECRET_NAMES) {
        expect(text.includes(`${name}=`)).toBe(false);
      }
      expect(text).not.toMatch(/argon2id\$[^"'\s]{10,}/); // a PIN hash would look like this
    }
  });
});

test.describe("PWA manifest (US-1.4)", () => {
  test("is installable: valid JSON, standalone display, icons present", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.ok()).toBe(true);
    const manifest = await res.json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    for (const icon of manifest.icons) {
      const iconRes = await request.get(icon.src);
      expect(iconRes.ok(), `${icon.src} must be reachable`).toBe(true);
    }
  });
});

test.describe("Offline fallback (NFR-RES-4)", () => {
  test("shows a friendly message and a retry action", async ({ page }) => {
    await page.goto("/offline");
    await expect(page.getByRole("heading")).toBeVisible();
    await expect(page.getByRole("link", { name: /./ })).toBeVisible();
  });
});

test.describe("Role gates without a session redirect to /login (US-1.2 KP-2, defence in depth)", () => {
  for (const path of ["/parent", "/parent/settings", "/parent/child", "/today", "/onboarding", "/my-tutor"]) {
    test(`${path} does not render protected content for an anonymous visitor`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    });
  }
});
