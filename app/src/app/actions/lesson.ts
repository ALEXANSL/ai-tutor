"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { askTopicChat } from "@/server/lessons/chat";
import { recordChildFeedback, type ChildFeedbackKind } from "@/server/lessons/generate";
import {
  acknowledgeSlide,
  chooseStartBlock,
  continueAfterBlock,
  pauseLessonSession,
  resumeLessonSession,
  startLessonSession,
  submitStepAnswer,
  type StartCandidate,
} from "@/server/lessons/orchestrator";
import type { FormState } from "./state";

/**
 * Lesson server actions. **S3 restriction (docs/STATUS.md, backlog S3
 * note):** every action re-checks `requireParentAccess()` — the lesson
 * exists only for demoing to Alex / in "режим тата" until S4's safety rules
 * are verified; the child cannot start or answer a lesson on her own yet.
 */
const UUID = z.string().uuid();

async function onlyChild(familyId: string): Promise<ChildProfileRow> {
  const { data } = await forFamily(familyId).select("child_profile", "*").maybeSingle<ChildProfileRow>();
  if (!data) throw new Error("no child profile in this family yet");
  return data;
}

/**
 * BUG-011: `startLessonSession` itself no longer throws for "no block passed
 * review" (it falls back to the safe template) — but it can still fail for
 * reasons that fallback can't paper over (no indexed textbook, a real DB
 * error). Those are caught here and turned into a specific, human-readable
 * message instead of letting `StartLessonButton` show the generic
 * `uk.common.error` ("Щось пішло не так").
 */
export async function startLessonAction(
  subjectId: string,
  topicId: string,
): Promise<{ status: "ok"; sessionId: string; candidates: StartCandidate[] } | { status: "error"; message: string }> {
  const { familyId } = await requireParentAccess();
  UUID.parse(subjectId);
  UUID.parse(topicId);
  try {
    const child = await onlyChild(familyId);
    const minutes = child.lesson_minutes;
    const { sessionId, candidates } = await startLessonSession(familyId, child.id, subjectId, topicId, minutes);
    return { status: "ok", sessionId, candidates };
  } catch (e) {
    const err = e as Error;
    console.error(`startLessonAction failed: ${err.message}`);
    const message = err.message.includes("no indexed textbook fragments")
      ? uk.parent.subjects.errors.noTextbook
      : uk.parent.subjects.errors.startLessonFailed;
    return { status: "error", message };
  }
}

export async function chooseStartBlockAction(sessionId: string, libraryItemId: string) {
  const { familyId } = await requireParentAccess();
  UUID.parse(sessionId);
  UUID.parse(libraryItemId);
  const step = await chooseStartBlock(familyId, sessionId, libraryItemId);
  revalidatePath(`/lesson/${sessionId}`);
  return step;
}

const answerSchema = z.object({
  channel: z.enum(["choice", "text", "voice", "photo"]),
  answer: z.unknown(),
  latencyMs: z.number().int().min(0).max(600_000).nullable(),
});

export async function submitStepAnswerAction(
  sessionId: string,
  stepId: string,
  idempotencyKey: string,
  input: z.infer<typeof answerSchema>,
) {
  const { familyId } = await requireParentAccess();
  UUID.parse(sessionId);
  UUID.parse(stepId);
  UUID.parse(idempotencyKey);
  const { channel, answer, latencyMs } = answerSchema.parse(input);
  const result = await submitStepAnswer(familyId, sessionId, stepId, idempotencyKey, channel, answer, latencyMs);
  revalidatePath(`/lesson/${sessionId}`);
  return result;
}

export async function acknowledgeSlideAction(sessionId: string, stepId: string) {
  const { familyId } = await requireParentAccess();
  UUID.parse(sessionId);
  UUID.parse(stepId);
  const next = await acknowledgeSlide(familyId, sessionId, stepId);
  revalidatePath(`/lesson/${sessionId}`);
  return next;
}

/** US-6.6 (Тривога), US-16.4 КП-2 (бездіяльність), and the offline banner all pause the same way. */
export async function pauseLessonAction(sessionId: string, reason: "manual_alert" | "idle" | "network"): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  UUID.parse(sessionId);
  await pauseLessonSession(familyId, sessionId, reason);
  revalidatePath(`/lesson/${sessionId}`);
  return { status: "ok" };
}

export async function resumeLessonAction(sessionId: string) {
  const { familyId } = await requireParentAccess();
  UUID.parse(sessionId);
  const result = await resumeLessonSession(familyId, sessionId);
  revalidatePath(`/lesson/${sessionId}`);
  return result;
}

/** US-6.13: continues past a block's "visible outcome" screen (BUG-009 fix lives in `continueAfterBlock`). */
export async function continueAfterBlockAction(sessionId: string) {
  const { familyId } = await requireParentAccess();
  UUID.parse(sessionId);
  const next = await continueAfterBlock(familyId, sessionId);
  revalidatePath(`/lesson/${sessionId}`);
  return next;
}

const feedbackSchema = z.enum(["interesting", "normal", "boring"]);

/** US-6.13 КП-3 / US-6.10 КП-3: one tap, optional, never affects points. */
export async function submitBlockFeedbackAction(libraryItemId: string, feedback: ChildFeedbackKind) {
  const { familyId } = await requireParentAccess();
  UUID.parse(libraryItemId);
  await recordChildFeedback(familyId, libraryItemId, feedbackSchema.parse(feedback));
  return { status: "ok" as const };
}

const chatSchema = z.string().trim().min(1).max(800);

export async function askTopicChatAction(sessionId: string | null, subjectId: string, topicId: string, question: string) {
  const { familyId } = await requireParentAccess();
  UUID.parse(subjectId);
  UUID.parse(topicId);
  const q = chatSchema.parse(question);
  const scope = forFamily(familyId);
  const child = await onlyChild(familyId);
  const [{ data: subject }, { data: topic }] = await Promise.all([
    scope.select("subjects", "name_uk").eq("id", subjectId).maybeSingle<{ name_uk: string }>(),
    scope.select("topics", "title").eq("id", topicId).maybeSingle<{ title: string }>(),
  ]);
  if (!subject || !topic) return { status: "error" as const, message: uk.common.error };
  const message = await askTopicChat(
    familyId,
    child.id,
    child.nickname ?? "",
    child.tutor_name ?? "",
    subjectId,
    subject.name_uk,
    topicId,
    topic.title,
    q,
    sessionId ?? undefined,
  );
  return { status: "ok" as const, message };
}
