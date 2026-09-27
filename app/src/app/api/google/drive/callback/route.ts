import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireParentAccount } from "@/server/auth/guards";
import { getAppBaseUrl } from "@/server/env";
import { connectGoogleDrive } from "@/server/drive/oauth";
import { getServiceAccountEmail } from "@/server/drive/service";
import { DriveError } from "@/server/drive/google";
import { STATE_COOKIE } from "../connect/route";

function statesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * Google redirects the parent back here after consent (ADR-024). Exchanges
 * the code, stores the refresh token, creates + auto-shares the "Мої книги"
 * folder, then sends the parent back to Settings with a status the page
 * turns into a concrete message (BUG-005 pattern — never a generic failure).
 */
export async function GET(request: NextRequest) {
  const { familyId } = await requireParentAccount();
  const base = getAppBaseUrl(request.nextUrl.origin);
  const to = (query: string) => {
    const res = NextResponse.redirect(`${base}/parent/settings?${query}`, 303);
    res.cookies.delete(STATE_COOKIE);
    res.headers.set("Cache-Control", "no-store");
    return res;
  };

  const params = request.nextUrl.searchParams;
  if (params.get("error")) return to("drive_error=denied");

  const code = params.get("code");
  const state = params.get("state");
  const cookieState = request.cookies.get(STATE_COOKIE)?.value;
  if (!code || !state || !cookieState || !statesMatch(state, cookieState)) return to("drive_error=state");

  try {
    await connectGoogleDrive(familyId, code, `${base}/api/google/drive/callback`, getServiceAccountEmail());
  } catch (e) {
    console.error(`connectGoogleDrive failed: ${(e as Error).name}: ${(e as Error).message}`);
    const errCode = e instanceof DriveError ? e.code : "http";
    return to(`drive_error=${errCode === "not_configured" ? "not_configured" : "failed"}`);
  }
  return to("drive=connected");
}
