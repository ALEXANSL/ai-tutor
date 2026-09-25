"use server";

import { revalidatePath } from "next/cache";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { FormState } from "./state";

/**
 * "Предмети" actions (US-3.1). Every action re-checks the parent role on the
 * server (parent account or PIN-unlocked parent mode).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = uk.parent.subjects.errors;

/**
 * Picks the subject's current topic and activates the subject (US-3.1 KP-1).
 * A subject with no ready, enabled textbook cannot be activated (KP-2): the
 * action returns a plain explanation instead of a generic error, and the
 * check is re-done here even though the page already hides the form, since a
 * server action must not trust the client state.
 */
export async function setCurrentTopicAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const subjectId = String(formData.get("subjectId") ?? "");
  const topicId = String(formData.get("topicId") ?? "");
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  if (!UUID.test(topicId)) return { status: "error", message: t.pickTopicFirst };

  const scope = forFamily(familyId);
  const { data: subject } = await scope.select("subjects", "id").eq("id", subjectId).eq("is_stub", false).maybeSingle<{ id: string }>();
  if (!subject) return { status: "error", message: uk.common.error };

  const { count: readyTextbooks } = await scope
    .count("materials")
    .eq("subject_id", subjectId)
    .eq("kind", "textbook")
    .eq("status", "ready")
    .eq("use_in_lessons", true);
  if (!readyTextbooks) return { status: "error", message: t.noTextbook };

  const { data: topic } = await scope.select("topics", "id, subject_id").eq("id", topicId).maybeSingle<{ id: string; subject_id: string }>();
  if (!topic || topic.subject_id !== subjectId) return { status: "error", message: t.topicNotFound };

  const clear = await scope.update("topics", { is_current: false }).eq("subject_id", subjectId).eq("is_current", true);
  if (clear.error) return { status: "error", message: uk.common.error };
  const set = await scope.update("topics", { is_current: true }).eq("id", topicId);
  if (set.error) return { status: "error", message: uk.common.error };
  const activate = await scope.update("subjects", { active: true }).eq("id", subjectId);
  if (activate.error) return { status: "error", message: uk.common.error };

  revalidatePath("/parent/subjects", "layout");
  return { status: "ok", message: uk.parent.subjects.detail.saved };
}
