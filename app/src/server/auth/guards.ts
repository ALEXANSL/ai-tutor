import "server-only";
import { redirect } from "next/navigation";
import type { ChildProfileRow } from "../db/types";
import { createUserClient } from "../supabase/clients";
import { getSessionContext, type UserContext } from "./session";

/** Any registered user, or redirect to the right entry screen. */
export async function requireUser(): Promise<UserContext> {
  const ctx = await getSessionContext();
  switch (ctx.kind) {
    case "user":
      return ctx;
    case "forbidden":
      redirect("/no-access");
    case "not_configured":
      redirect("/login?error=config");
    default:
      redirect("/login");
  }
}

/**
 * Child-only screens. The parent's own account is sent to the cabinet.
 * Unless `allowOnboarding`, a child who has not finished onboarding is sent there.
 */
export async function requireChild(options: { allowOnboarding?: boolean } = {}): Promise<{
  ctx: UserContext;
  profile: ChildProfileRow;
}> {
  const ctx = await requireUser();
  if (ctx.role !== "child") redirect("/parent");
  // Own profile through RLS (the child can read only her own row).
  const supabase = await createUserClient();
  const { data: profile } = await supabase
    .from("child_profile")
    .select("*")
    .eq("app_user_id", ctx.appUserId)
    .maybeSingle<ChildProfileRow>();
  if (!profile) redirect("/login");
  if (!options.allowOnboarding && !profile.onboarding_completed_at) redirect("/onboarding");
  return { ctx, profile };
}

export interface ParentAccess {
  ctx: UserContext;
  familyId: string;
  /** "account": parent's own Google session; "tablet": child session + PIN (parent mode). */
  via: "account" | "tablet";
}

/** Cabinet screens and actions (US-1.2 KP-2, US-1.5 KP-1, NFR-PRIV-4). */
export async function requireParentAccess(): Promise<ParentAccess> {
  const ctx = await requireUser();
  if (ctx.role === "parent") return { ctx, familyId: ctx.familyId, via: "account" };
  if (ctx.parentMode === "active") return { ctx, familyId: ctx.familyId, via: "tablet" };
  // Parent mode timed out (auto-exit) -> back to the child's screen; otherwise: denied.
  redirect(ctx.parentMode === "expired" ? "/today" : "/denied");
}

/**
 * Lesson / topic chat / "ШІ-друг" screens (S4, US-12.1..12.3 verified —
 * docs/STATUS.md): the child now uses these herself, not only "режим тата"
 * (the S3 restriction this replaced). A parent's own account or tablet
 * parent mode may still open them too (demo, QA, "тато грає за дитину").
 */
export async function requireLessonAccess(): Promise<{ ctx: UserContext; familyId: string }> {
  const session = await getSessionContext();
  if (session.kind === "user" && session.role === "child") {
    const { ctx } = await requireChild(); // also redirects to /onboarding if not finished yet.
    return { ctx, familyId: ctx.familyId };
  }
  return requireParentAccess();
}

/** Parent's own Google session only (e.g. setting the PIN — US-1.5 KP-5). */
export async function requireParentAccount(): Promise<ParentAccess> {
  const access = await requireParentAccess();
  if (access.via !== "account") redirect("/parent/settings");
  return access;
}
