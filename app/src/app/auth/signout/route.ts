import { NextResponse, type NextRequest } from "next/server";
import { clearParentMode } from "@/server/auth/parent-mode";
import { getAppBaseUrl, getPublicSupabaseConfig } from "@/server/env";
import { createUserClient } from "@/server/supabase/clients";

export async function POST(request: NextRequest) {
  const base = getAppBaseUrl(request.nextUrl.origin);
  if (getPublicSupabaseConfig()) {
    const supabase = await createUserClient();
    await supabase.auth.signOut();
  }
  await clearParentMode();
  return NextResponse.redirect(`${base}/login`, 303);
}
