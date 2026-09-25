import { NextResponse, type NextRequest } from "next/server";
import { resolveRole } from "@/server/auth/allowlist";
import { getAllowlist, getAppBaseUrl, getPublicSupabaseConfig } from "@/server/env";
import { getFamilyDefaults } from "@/server/family-defaults";
import { createServiceClient, createUserClient } from "@/server/supabase/clients";

/**
 * OAuth callback (US-1.1 KP-1, KP-2; ADR-002 p.2): exchange the code, check
 * the allowlist, register the user (server-only) or deny and clean up.
 */
export async function GET(request: NextRequest) {
  const base = getAppBaseUrl(request.nextUrl.origin);
  const to = (path: string) => NextResponse.redirect(`${base}${path}`, 303);
  if (!getPublicSupabaseConfig()) return to("/login?error=config");

  const code = request.nextUrl.searchParams.get("code");
  if (!code) return to("/login?error=auth");

  const supabase = await createUserClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) return to("/login?error=auth");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return to("/login?error=auth");

  const service = createServiceClient();
  const decision = resolveRole(user.email, getAllowlist());
  if (!decision.ok) {
    // Not allowlisted: sign out and delete the just-created auth user, unless it
    // belongs to an already registered member (then only sign out; data stays).
    const { data: member } = await service
      .from("app_users")
      .select("id")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    await supabase.auth.signOut();
    if (!member) await service.auth.admin.deleteUser(user.id);
    return to(decision.reason === "not_configured" ? "/login?error=config" : "/login?error=no_access");
  }

  const { data: registered, error: registerError } = await service
    .rpc("register_app_user", {
      p_auth_user_id: user.id,
      p_role: decision.role,
      p_defaults: getFamilyDefaults(),
    })
    .single<{ app_user_id: string; family_id: string; role: string }>();
  if (registerError || !registered) {
    await supabase.auth.signOut();
    return to("/login?error=auth");
  }

  if (decision.role === "parent") return to("/parent");
  const { data: profile } = await service
    .from("child_profile")
    .select("onboarding_completed_at")
    .eq("app_user_id", registered.app_user_id)
    .eq("family_id", registered.family_id)
    .maybeSingle<{ onboarding_completed_at: string | null }>();
  return to(profile?.onboarding_completed_at ? "/today" : "/onboarding");
}
