"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { uk } from "@/i18n/uk";
import { requireChild, requireLessonAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { kickJobs } from "@/server/jobs/kick";
import { askTopicChat, explainStepAgain } from "@/server/lessons/chat";
import { recordChildFeedback, type ChildFeedbackKind } from "@/server/lessons/generate";
import { readableTextForStep } from "@/server/lessons/narration";
import { getOrSynthesizeStepNarration } from "@/server/lessons/narrationCache";
import {
  acknowledgeSlide,
  checkWarmupProgress,
  chooseStartBlock,
  continueAfterBlock,
  getPreviousModuleView,
  goToPreviousStep,
  pauseLessonSession,
  resumeLessonSession,
  setPresentationMode,
  skipLessonBreak,
  startLessonSession,
  submitStepAnswer,
  takeLessonBreak,
  tickLessonActivity,
  type LessonStepView,
  type PreviousModuleView,
  type StartCandidate,
} from "@/server/lessons/orchestrator";
import { ensureActiveLibraryBlock, type EnsureActiveLibraryBlockResult } from "@/server/lessons/warmup";
import { getSubjectForBulkWarmup } from "@/server/subjects/queries";
import type { FormState } from "./state";

// BUG (urgent, pre-D-65 demo fix): `startLessonAction` runs the full
// lesson-generation pipeline (lesson_planning + lesson_generation on Claude,
// then lesson_review, possibly with rework) synchronously, which regularly
// exceeds the platform's default Server Function duration and the request
// gets cut off with no error surfaced to the child ("Почати" just hangs").
// A "use server" file itself may only export async functions (this Next.js
// version rejects a `maxDuration` export here at build time), so the fix
// instead lives as a `maxDuration` route-segment export on every page that
// can trigger this action: `(child)/subject/[id]`, `parent/subjects/[id]`
// (both call `startLessonAction`) and `(child)/lesson/[sessionId]` (calls
// `chooseStartBlockAction`, which runs `activateBlock` — cheap, but shares
// the same generous budget for consistency and any future slow path there).

/**
 * Lesson server actions. **S4 (docs/STATUS.md):** the child now opens and
 * plays a lesson herself (`requireLessonAccess()`); a parent's own account
 * or tablet parent mode may still open it too (demo, QA). Removes the S3
 * restriction ("режим тата" only), now that safety moderation (ADR-009) and
 * the "Я — ШІ" honesty rules are wired in.
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
): Promise<
  | { status: "ok"; sessionId: string; candidates: StartCandidate[] }
  // `reason` is a machine-readable tag for the SAME condition `message`
  // already describes in words. `message` stays worded for the PARENT
  // caller (`StartLessonButton`, `parent/subjects/[id]`); the CHILD caller
  // (`ChildStartLessonButton`) must not render `message` for `no_textbook`
  // — it has its own child-appropriate copy keyed off `reason` instead, so
  // the parent-facing "«Мої книги»" instruction never reaches the child.
  | { status: "error"; message: string; reason?: "no_textbook" }
> {
  const { familyId } = await requireLessonAccess();
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
    if (err.message.includes("no indexed textbook fragments")) {
      return { status: "error", message: uk.parent.subjects.errors.noTextbook, reason: "no_textbook" };
    }
    return { status: "error", message: uk.parent.subjects.errors.startLessonFailed };
  }
}

/**
 * BUG-016 (live demo): this used to let `chooseStartBlock` throw straight
 * through the Server Action. `LessonPicker` catches the *action call*
 * itself, so that alone was already usually fine — but wrapping it here
 * too, the same way `startLessonAction` does, means a failure here can
 * never reach the child as a bare unhandled rejection either. The render
 * that actually showed Next's generic error page happens one step later
 * (the `/lesson/[sessionId]` page re-rendering after `router.refresh()`),
 * which is guarded separately by that route's `error.tsx`.
 */
export async function chooseStartBlockAction(
  sessionId: string,
  libraryItemId: string,
): Promise<{ status: "ok"; step: Awaited<ReturnType<typeof chooseStartBlock>> } | { status: "error"; message: string }> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  UUID.parse(libraryItemId);
  try {
    const step = await chooseStartBlock(familyId, sessionId, libraryItemId);
    revalidatePath(`/lesson/${sessionId}`);
    return { status: "ok", step };
  } catch (e) {
    console.error(`chooseStartBlockAction failed: ${(e as Error).message}`);
    return { status: "error", message: uk.common.error };
  }
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
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  UUID.parse(stepId);
  UUID.parse(idempotencyKey);
  const { channel, answer, latencyMs } = answerSchema.parse(input);
  const result = await submitStepAnswer(familyId, sessionId, stepId, idempotencyKey, channel, answer, latencyMs);
  revalidatePath(`/lesson/${sessionId}`);
  return result;
}

export async function acknowledgeSlideAction(sessionId: string, stepId: string) {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  UUID.parse(stepId);
  const next = await acknowledgeSlide(familyId, sessionId, stepId);
  revalidatePath(`/lesson/${sessionId}`);
  return next;
}

/**
 * US-6.6 (Тривога), US-16.4 КП-2 (бездіяльність), the offline banner, and
 * BUG-020's explicit "Вийти з уроку" all pause the same way — the current
 * step is kept, and `resumeLessonAction` picks up right there.
 */
export async function pauseLessonAction(sessionId: string, reason: "manual_alert" | "manual_exit" | "idle" | "network"): Promise<FormState> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  await pauseLessonSession(familyId, sessionId, reason);
  revalidatePath(`/lesson/${sessionId}`);
  return { status: "ok" };
}

export async function resumeLessonAction(sessionId: string) {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  const result = await resumeLessonSession(familyId, sessionId);
  revalidatePath(`/lesson/${sessionId}`);
  return result;
}

/** US-6.13: continues past a block's "visible outcome" screen (BUG-009 fix lives in `continueAfterBlock`). */
export async function continueAfterBlockAction(sessionId: string) {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  const next = await continueAfterBlock(familyId, sessionId);
  revalidatePath(`/lesson/${sessionId}`);
  return next;
}

const feedbackSchema = z.enum(["interesting", "normal", "boring"]);

/** US-6.13 КП-3 / US-6.10 КП-3: one tap, optional, never affects points. */
export async function submitBlockFeedbackAction(libraryItemId: string, feedback: ChildFeedbackKind) {
  const { familyId } = await requireLessonAccess();
  UUID.parse(libraryItemId);
  await recordChildFeedback(familyId, libraryItemId, feedbackSchema.parse(feedback));
  return { status: "ok" as const };
}

const chatSchema = z.string().trim().min(1).max(800);

export async function askTopicChatAction(sessionId: string | null, subjectId: string, topicId: string, question: string) {
  const { familyId } = await requireLessonAccess();
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
    child.tutor_name_gender,
    subjectId,
    subject.name_uk,
    topicId,
    topic.title,
    q,
    sessionId ?? undefined,
  );
  return { status: "ok" as const, message };
}

/** US-12.2 КП-1: a heartbeat from the running lesson screen (≈ every 20 s). */
export async function tickLessonActivityAction(sessionId: string, deltaSeconds: number) {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  return tickLessonActivity(familyId, sessionId, Math.min(Math.max(0, Math.round(deltaSeconds)), 120));
}

/** US-12.2 КП-2: "Перерва" — starts right away, state saved (like any other pause). */
export async function takeLessonBreakAction(sessionId: string): Promise<FormState> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  await takeLessonBreak(familyId, sessionId);
  revalidatePath(`/lesson/${sessionId}`);
  return { status: "ok" };
}

/** US-12.2 КП-1/КП-3: "Продовжити без перерви" — logged, never blocks. */
export async function skipLessonBreakAction(sessionId: string): Promise<{ status: "ok" }> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  await skipLessonBreak(familyId, sessionId);
  return { status: "ok" };
}

/**
 * US-6.16 КП-1 ("Пояснити"): the current step, explained differently, posted
 * into the topic chat (docs/04 §11.4). Not a graded attempt, so `stepId` is
 * only checked against the session's own current step, like every other
 * per-step action here.
 */
export async function explainStepAction(sessionId: string, stepId: string, subjectId: string, topicId: string) {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  UUID.parse(stepId);
  UUID.parse(subjectId);
  UUID.parse(topicId);
  const scope = forFamily(familyId);
  const [{ data: session }, { data: stepRow }, { data: subject }, { data: topic }] = await Promise.all([
    scope.select("lesson_sessions", "current_step_id").eq("id", sessionId).maybeSingle<{ current_step_id: string | null }>(),
    scope.select("library_steps", "type, content").eq("id", stepId).maybeSingle<{ type: string; content: Record<string, unknown> }>(),
    scope.select("subjects", "name_uk").eq("id", subjectId).maybeSingle<{ name_uk: string }>(),
    scope.select("topics", "title").eq("id", topicId).maybeSingle<{ title: string }>(),
  ]);
  if (!session || session.current_step_id !== stepId || !stepRow || !subject || !topic) {
    return { status: "error" as const, message: uk.common.error };
  }
  const child = await onlyChild(familyId);
  const message = await explainStepAgain(
    familyId,
    child.id,
    child.tutor_name ?? "",
    child.tutor_name_gender,
    subjectId,
    subject.name_uk,
    topicId,
    topic.title,
    child.nickname ?? "",
    readableTextForStep(stepRow),
    sessionId,
  );
  return { status: "ok" as const, message };
}

const presentationModeSchema = z.enum(["voice", "auto", "text"]);

/** US-6.16 КП-5: the "🔊 Вголос / 🤖 Авто / 🔤 Текстом" switch. */
export async function setPresentationModeAction(sessionId: string, mode: string): Promise<FormState> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  await setPresentationMode(familyId, sessionId, presentationModeSchema.parse(mode));
  revalidatePath(`/lesson/${sessionId}`);
  return { status: "ok" };
}

const NARRATION_STEP_COLUMNS = "id, type, content, narration_text_hash, narration_audio_base64, narration_audio_mime";
type NarrationStepRow = {
  id: string;
  type: string;
  content: Record<string, unknown>;
  narration_text_hash: string | null;
  narration_audio_base64: string | null;
  narration_audio_mime: string | null;
};

/**
 * US-6.16 КП-5 (режим «Вголос»): synthesizes (or returns already-cached)
 * narration for the current step's own text. Never a hard failure for the
 * child — see `synthesizeStepNarration`'s doc comment. PO complaint
 * 2026-10-02 ("до 30 секунд поки ШІ починає читати вголос"): this used to
 * call the TTS provider fresh on EVERY call, with no caching at all — see
 * `narrationCache.ts`'s doc comment for the fix.
 */
export async function synthesizeNarrationAction(
  sessionId: string,
  stepId: string,
): Promise<{ status: "ok"; audioBase64: string; mimeType: string } | { status: "unavailable" }> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  UUID.parse(stepId);
  const scope = forFamily(familyId);
  const [{ data: session }, { data: stepRow }] = await Promise.all([
    scope.select("lesson_sessions", "current_step_id").eq("id", sessionId).maybeSingle<{ current_step_id: string | null }>(),
    scope.select("library_steps", NARRATION_STEP_COLUMNS).eq("id", stepId).maybeSingle<NarrationStepRow>(),
  ]);
  if (!session || session.current_step_id !== stepId || !stepRow) return { status: "unavailable" };
  const audio = await getOrSynthesizeStepNarration(familyId, sessionId, stepRow);
  if (!audio) return { status: "unavailable" };
  return { status: "ok", ...audio };
}

/**
 * PO complaint 2026-10-02 (candidate fix (a), narration latency): fires the
 * SAME cache-or-synthesize path as `synthesizeNarrationAction` above, but
 * for the step that would come immediately after `afterStepId` within its
 * own block (`library_steps.sort_order + 1`, same `item_id`) — called as
 * soon as the CURRENT step is shown, regardless of presentation mode, so
 * narration for the likely-next step is already warmed by the time the
 * child reaches or switches it to voice. Read-only w.r.t. lesson progress
 * (never advances `current_step_id`, never mutates `lesson_sessions`) and
 * best-effort: the real "next" step the orchestrator actually serves can
 * differ for a branching (e.g. remediation) step, in which case this simply
 * warmed a step that wasn't needed yet — harmless, since the cache write is
 * keyed by that step's own id/text hash and will just sit there until (if
 * ever) that step is actually shown.
 */
export async function prefetchNextStepNarrationAction(sessionId: string, afterStepId: string): Promise<void> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  UUID.parse(afterStepId);
  const scope = forFamily(familyId);
  const { data: current } = await scope
    .select("library_steps", "item_id, sort_order")
    .eq("id", afterStepId)
    .maybeSingle<{ item_id: string; sort_order: number }>();
  if (!current) return;
  const { data: nextStep } = await scope
    .select("library_steps", NARRATION_STEP_COLUMNS)
    .eq("item_id", current.item_id)
    .eq("sort_order", current.sort_order + 1)
    .maybeSingle<NarrationStepRow>();
  if (!nextStep) return;
  await getOrSynthesizeStepNarration(familyId, sessionId, nextStep);
}

/** US-6.16 КП-2: read-only preview of the block completed just before the current one. */
export async function getPreviousModuleAction(sessionId: string): Promise<PreviousModuleView | null> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  return getPreviousModuleView(familyId, sessionId);
}

/**
 * BUG-029 (follow-up per PO): real "⬅️" step-back navigation within the
 * current active block — `null` when already at that block's first step
 * (the caller then falls back to `getPreviousModuleAction`'s read-only
 * preview of the earlier, completed block, if any).
 */
export async function goToPreviousStepAction(sessionId: string): Promise<LessonStepView | null> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  return goToPreviousStep(familyId, sessionId);
}

/**
 * ADR-023 §Частина 1.7: polled by `LibraryWarmProgress` while the session's
 * `mode === "warming"` (a "cold" topic that had no active library block at
 * start). Once ready, revalidates the lesson page so the next render picks
 * up the session's own new `mode` (moved to `choosing` by
 * `checkWarmupProgress` itself) instead of returning candidates here too.
 */
export async function checkWarmupProgressAction(
  sessionId: string,
): Promise<{ status: "ok"; ready: boolean; stage: string | null; reviewPass: number | null } | { status: "error"; message: string }> {
  const { familyId } = await requireLessonAccess();
  UUID.parse(sessionId);
  try {
    const progress = await checkWarmupProgress(familyId, sessionId);
    if (progress.ready) revalidatePath(`/lesson/${sessionId}`);
    else kickJobs();
    return { status: "ok", ready: progress.ready, stage: progress.stage, reviewPass: progress.reviewPass };
  } catch (e) {
    console.error(`checkWarmupProgressAction failed: ${(e as Error).message}`);
    return { status: "error", message: uk.common.error };
  }
}

/**
 * US-19.5 КП-2 (S38, D-114): the child's own "Підготувати" tap on a
 * "Потрібна підготовка" topic card (`/subject/[id]`) — queues background
 * generation WITHOUT navigating her into the lesson/warming screen (that's
 * the whole point of this entry point; the existing "Готуємо урок…"
 * full-screen wait, D-66/ADR-023, is unchanged and still reachable via
 * "Почати"). Reuses `ensureActiveLibraryBlock` exactly as every other warm-up
 * trigger does — no new pipeline — tagged `source: "child_initiated"` and
 * WITHOUT `bypassDailyBudget`, so it counts toward the same daily $5 family
 * warm-up soft cap as any other warm-up call (ВП-66, confirmed closed).
 *
 * `immediate: false` on purpose: same "can wait a few seconds, not
 * blocking" budget as the parent's `is_current` signal (§Частина 1.1) — the
 * child is not staring at a spinner waiting for this call to return.
 */
export async function prepareTopicAction(
  subjectId: string,
  topicId: string,
): Promise<{ status: "ok"; warmStatus: EnsureActiveLibraryBlockResult["status"] } | { status: "error"; message: string }> {
  const { ctx } = await requireChild();
  UUID.parse(subjectId);
  UUID.parse(topicId);
  try {
    const subject = await getSubjectForBulkWarmup(ctx.familyId, subjectId, [topicId]);
    const topic = subject?.topics.find((tp) => tp.id === topicId);
    if (!subject || !topic) return { status: "error", message: uk.common.error };

    const result = await ensureActiveLibraryBlock(
      ctx.familyId,
      { id: subject.id, nameUk: subject.nameUk, config: subject.config },
      { id: topic.id, title: topic.title, grade: topic.grade },
      { immediate: false, source: "child_initiated" },
    );
    revalidatePath(`/subject/${subjectId}`);
    return { status: "ok", warmStatus: result.status };
  } catch (e) {
    console.error(`prepareTopicAction failed: ${(e as Error).message}`);
    return { status: "error", message: uk.common.error };
  }
}
