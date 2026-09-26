import "server-only";
import { redirect } from "next/navigation";
import type { ChildProfileRow } from "../db/types";
import { createUserClient } from "../supabase/clients";
import { getSessionContext, type ParentModeState, type UserContext } from "./session";

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

/**
 * Where a non-active tablet parent mode sends the caller. Split out as a
 * pure function so BUG-027's "which screen does a softened auto-exit land
 * on" fix is testable without mocking cookies/Supabase for the whole of
 * `requireParentAccess`.
 *
 * `"expired"` covers both an ordinary idle timeout AND, since BUG-027, the
 * `ParentModeAutoExit` side effect (`expireParentModeSilently` deliberately
 * produces this same state rather than `"none"`) — both are "you were in,
 * now you're not, no big deal" and get the friendly `/today` redirect.
 * `"none"` means parent mode was never entered on this device at all, which
 * is a real access-denied case (e.g. a direct URL to a cabinet route).
 */
export function parentAccessRedirectTarget(mode: ParentModeState): "/today" | "/denied" {
  return mode === "expired" ? "/today" : "/denied";
}

/** Cabinet screens and actions (US-1.2 KP-2, US-1.5 KP-1, NFR-PRIV-4). */
export async function requireParentAccess(): Promise<ParentAccess> {
  const ctx = await requireUser();
  if (ctx.role === "parent") return { ctx, familyId: ctx.familyId, via: "account" };
  if (ctx.parentMode === "active") return { ctx, familyId: ctx.familyId, via: "tablet" };
  // Parent mode timed out or was softly auto-exited (BUG-027) -> back to the
  // child's screen; genuinely never entered -> denied.
  redirect(parentAccessRedirectTarget(ctx.parentMode));
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
