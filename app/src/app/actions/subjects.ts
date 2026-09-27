"use server";

import { revalidatePath } from "next/cache";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { warmAheadForSubject } from "@/server/lessons/warmup";
import type { FormState } from "./state";

/**
 * "Предмети" actions (US-3.1). Every action re-checks the parent role on the
 * server (parent account or PIN-unlocked parent mode).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = uk.parent.subjects.errors;

/** errcode -> user-facing message, set by `public.set_current_topic` (BUG-006). */
const RPC_ERROR_MESSAGE: Record<string, string> = {
  P0002: uk.common.error, // subject_not_found
  P0003: t.topicNotFound, // topic_not_found
  P0004: t.noTextbook, // no_textbook
};

/**
 * E-22 (US-22.1/22.2/22.3, ADR-030): the 9 new SECURITY DEFINER RPCs share
 * the same errcode set (`add_subject`, `rename_subject`, `set_subject_active`,
 * `add_course`, `update_course`, `add_course_group`, `rename_course_group`,
 * `set_course_group_active`) — P0010 invalid name, P0011 duplicate name,
 * P0002/P0012 not found (subject/group). The user-facing TEXT differs by
 * which screen called it (a school subject vs a course vs a group), so each
 * action below picks its own dictionary rather than sharing one map.
 */
function rpcErrorMessage(dict: { invalidName: string; duplicateName: string; notFound: string; groupNotFound?: string }, code: string | undefined): string {
  switch (code) {
    case "P0010":
      return dict.invalidName;
    case "P0011":
      return dict.duplicateName;
    case "P0012":
      return dict.groupNotFound ?? dict.notFound;
    case "P0002":
      return dict.notFound;
    default:
      return uk.common.error;
  }
}

const UUID_OR_EMPTY = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;

function nameOf(formData: FormData): string {
  return String(formData.get("name") ?? "").trim();
}

function groupIdOf(formData: FormData): string | null {
  const raw = String(formData.get("groupId") ?? "").trim();
  return UUID_OR_EMPTY.test(raw) && raw !== "" ? raw : null;
}

// ---------------------------------------------------------------------------
// US-22.1: school subjects ("Предмети", kind='school_subject').
// ---------------------------------------------------------------------------

export async function addSubjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const name = nameOf(formData);
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("add_subject", { p_family_id: familyId, p_name_uk: name });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.subjects.errors, error.code) };
  revalidatePath("/parent/subjects", "layout");
  return { status: "ok", message: uk.parent.subjects.add.added };
}

export async function renameSubjectAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const subjectId = String(formData.get("subjectId") ?? "");
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  const name = nameOf(formData);
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("rename_subject", { p_family_id: familyId, p_subject_id: subjectId, p_name_uk: name });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.subjects.errors, error.code) };
  revalidatePath("/parent/subjects", "layout");
  return { status: "ok", message: uk.parent.subjects.rename.saved };
}

export async function toggleSubjectActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const subjectId = String(formData.get("subjectId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("set_subject_active", { p_family_id: familyId, p_subject_id: subjectId, p_active: active });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.subjects.errors, error.code) };
  revalidatePath("/parent/subjects", "layout");
  return { status: "ok", message: active ? uk.parent.subjects.toggleActive.activated : uk.parent.subjects.toggleActive.deactivated };
}

// ---------------------------------------------------------------------------
// US-22.2/22.3: courses and course groups ("Курси", kind='course'). A
// SEPARATE screen from "Предмети" (US-22.2 КП-1) — separate actions too, so
// there is no shared "kind switch" form (ADR-030 §4).
// ---------------------------------------------------------------------------

export async function addCourseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const name = nameOf(formData);
  const groupId = groupIdOf(formData);
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("add_course", { p_family_id: familyId, p_name_uk: name, p_group_id: groupId });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.courses.errors, error.code) };
  revalidatePath("/parent/courses", "layout");
  return { status: "ok", message: uk.parent.courses.add.added };
}

export async function updateCourseAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const subjectId = String(formData.get("subjectId") ?? "");
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  const name = nameOf(formData);
  const groupId = groupIdOf(formData);
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("update_course", { p_family_id: familyId, p_subject_id: subjectId, p_name_uk: name, p_group_id: groupId });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.courses.errors, error.code) };
  revalidatePath("/parent/courses", "layout");
  return { status: "ok", message: uk.parent.courses.detail.saved };
}

export async function toggleCourseActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const subjectId = String(formData.get("subjectId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  const scope = forFamily(familyId);
  // Same RPC as toggleSubjectActiveAction — set_subject_active is generic
  // over kind (ADR-030 §4); only the wording here differs.
  const { error } = await scope.client.rpc("set_subject_active", { p_family_id: familyId, p_subject_id: subjectId, p_active: active });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.courses.errors, error.code) };
  revalidatePath("/parent/courses", "layout");
  return { status: "ok", message: active ? uk.parent.courses.toggleActive.activated : uk.parent.courses.toggleActive.deactivated };
}

export async function addCourseGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const name = nameOf(formData);
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("add_course_group", { p_family_id: familyId, p_name_uk: name });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.courseGroups.errors, error.code) };
  revalidatePath("/parent/courses/groups", "layout");
  return { status: "ok", message: uk.parent.courseGroups.add.added };
}

export async function renameCourseGroupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const groupId = String(formData.get("groupId") ?? "");
  if (!UUID.test(groupId)) return { status: "error", message: uk.common.error };
  const name = nameOf(formData);
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("rename_course_group", { p_family_id: familyId, p_group_id: groupId, p_name_uk: name });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.courseGroups.errors, error.code) };
  revalidatePath("/parent/courses/groups", "layout");
  return { status: "ok", message: uk.parent.courseGroups.rename.saved };
}

export async function toggleCourseGroupActiveAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const groupId = String(formData.get("groupId") ?? "");
  const active = String(formData.get("active") ?? "") === "true";
  if (!UUID.test(groupId)) return { status: "error", message: uk.common.error };
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("set_course_group_active", { p_family_id: familyId, p_group_id: groupId, p_active: active });
  if (error) return { status: "error", message: rpcErrorMessage(uk.parent.courseGroups.errors, error.code) };
  revalidatePath("/parent/courses/groups", "layout");
  return { status: "ok", message: active ? uk.parent.courseGroups.toggleActive.activated : uk.parent.courseGroups.toggleActive.deactivated };
}

/**
 * Picks the subject's current topic and activates the subject (US-3.1 KP-1).
 * A subject with no ready, enabled textbook cannot be activated (KP-2): the
 * action returns a plain explanation instead of a generic error.
 *
 * The clear-old / set-new / activate-subject sequence used to be three
 * separate, non-transactional PostgREST calls (BUG-006): a network drop or a
 * double submit between them could leave the subject with zero or two
 * current topics. It is now a single atomic `security definer` RPC
 * (`public.set_current_topic`, service_role only) that re-validates
 * ownership and the "ready textbook" precondition itself, never trusting
 * the client, and a partial unique index backs the invariant at the schema
 * level regardless of the code path.
 */
export async function setCurrentTopicAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const subjectId = String(formData.get("subjectId") ?? "");
  const topicId = String(formData.get("topicId") ?? "");
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  if (!UUID.test(topicId)) return { status: "error", message: t.pickTopicFirst };

  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("set_current_topic", {
    p_family_id: familyId,
    p_subject_id: subjectId,
    p_topic_id: topicId,
  });
  if (error) {
    return { status: "error", message: RPC_ERROR_MESSAGE[error.code ?? ""] ?? uk.common.error };
  }

  // ADR-023 §Частина 1.1/§Частина 3.2 (D-76/D-103): the parent's own
  // "positive" signal warms up not just the one marked topic, but a
  // look-ahead of the next few topics of the subject's programme (anchored
  // on the topic just marked `is_current`, since `set_current_topic` above
  // already set it) — can wait a few seconds (not `immediate`), the next
  // `pg_cron` tick within a minute picks each one up. Never blocks or fails
  // this action either way (a failure here — e.g. the daily warm-up budget
  // already spent partway through the look-ahead — is not the parent's
  // problem right now; the child's own "cold" open still covers it).
  warmAheadForSubject(familyId, subjectId).catch((e: Error) => console.error(`library warm-ahead on is_current failed: ${e.message}`));

  revalidatePath("/parent/subjects", "layout");
  return { status: "ok", message: uk.parent.subjects.detail.saved };
}
