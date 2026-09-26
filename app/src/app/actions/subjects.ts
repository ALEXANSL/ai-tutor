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

/** errcode -> user-facing message, set by `public.set_current_topic` (BUG-006). */
const RPC_ERROR_MESSAGE: Record<string, string> = {
  P0002: uk.common.error, // subject_not_found
  P0003: t.topicNotFound, // topic_not_found
  P0004: t.noTextbook, // no_textbook
};

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

  revalidatePath("/parent/subjects", "layout");
  return { status: "ok", message: uk.parent.subjects.detail.saved };
}
