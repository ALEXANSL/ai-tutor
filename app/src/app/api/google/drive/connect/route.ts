import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { buildAuthorizeUrl } from "@/server/drive/oauth";
import { requireParentAccount } from "@/server/auth/guards";
import { getAppBaseUrl } from "@/server/env";

export const STATE_COOKIE = "gdrive_oauth_state";

/**
 * "Підключити Google Drive" (ADR-024): only the parent's own Google session
 * may start this (not a PIN-unlocked tablet parent mode) — same rule as
 * setting the PIN (`requireParentAccount`). Redirects straight to Google's
 * consent screen; the CSRF `state` is round-tripped via a short-lived,
 * httpOnly cookie, verified in `/api/google/drive/callback`.
 */
export async function GET(request: NextRequest) {
  await requireParentAccount();
  const base = getAppBaseUrl(request.nextUrl.origin);
  const state = randomBytes(24).toString("hex");
  const url = buildAuthorizeUrl(`${base}/api/google/drive/callback`, state);
  if (!url) {
    const res = NextResponse.redirect(`${base}/parent/settings?drive_error=not_configured`, 303);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  const res = NextResponse.redirect(url, 303);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/google/drive",
  });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
