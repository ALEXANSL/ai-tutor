import { NextResponse, type NextRequest } from "next/server";
import { getAppBaseUrl, getPublicSupabaseConfig } from "@/server/env";
import { createUserClient } from "@/server/supabase/clients";

/** Starts Google sign-in via Supabase Auth (ADR-002). Scopes: openid email profile. */
export async function POST(request: NextRequest) {
  const base = getAppBaseUrl(request.nextUrl.origin);
  if (!getPublicSupabaseConfig()) return NextResponse.redirect(`${base}/login?error=config`, 303);

  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${base}/auth/callback`,
      skipBrowserRedirect: true,
      // Let the child/parent pick the right Google account on a shared tablet.
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data.url) return NextResponse.redirect(`${base}/login?error=auth`, 303);
  return NextResponse.redirect(data.url, 303);
}
