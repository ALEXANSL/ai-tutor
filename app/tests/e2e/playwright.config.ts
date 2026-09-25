import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke e2e tests that need no Supabase/Google accounts (ADR-002 accounts are
 * not provisioned yet). They run against a production build with intentionally
 * MISSING backend secrets, so every route that needs auth shows the "not
 * configured" screen — this still lets us check the public/child-safe pages,
 * the PWA manifest, the tablet viewport and that no secret VALUE ever reaches
 * the page source.
 *
 * Once Supabase/Google accounts exist, extend this suite with signed-in flows
 * (onboarding, PIN, RLS-backed screens) — see docs/06-test-plan.md, "S0".
 */
const PORT = 4317;

// This sandbox ships a pre-installed Chromium outside Playwright's own cache
// (no internet access to download browsers). Use it when present; elsewhere
// (CI, a developer machine with `npx playwright install`) fall back to
// Playwright's own managed browser.
const SANDBOX_CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const executablePath = existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined;

export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `PORT=${PORT} npm run start`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    cwd: "../..",
    env: {
      // Deliberately absent: NEXT_PUBLIC_SUPABASE_URL, ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
      // ALLOWLIST_*, PIN_PEPPER — this suite covers the "not configured" / logged-out surface.
      NODE_ENV: "production",
    },
  },
  projects: [
    {
      name: "tablet-lenovo-yoga-11",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1200 }, // Lenovo Yoga 11, landscape (NFR-PLAT-1)
        launchOptions: {
          executablePath,
        },
      },
    },
    {
      name: "phone-galaxy-s24",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 412, height: 915 }, // Galaxy S24+ (NFR-PLAT-2)
        isMobile: true,
        hasTouch: true,
        launchOptions: {
          executablePath,
        },
      },
    },
  ],
});
