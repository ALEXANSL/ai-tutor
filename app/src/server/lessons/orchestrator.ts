import "server-only";
import { uk } from "@/i18n/uk";
import { getLessonComponent } from "@/lesson-components";
import { callStructured } from "@/server/ai/router";
import { forFamily } from "@/server/db/family-scope";
import { notifyParent } from "@/server/notifications";
import { moderateMessage } from "@/server/safety/moderate";
import { recordSafetyEvent } from "@/server/safety/events";
import { safetyPreambleGenericUk } from "@/server/safety/preamble";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";
import { createServiceClient } from "@/server/supabase/clients";
import { CANDIDATE_TARGET, getOrCreateFallbackBlock, getOrGenerateLessonBlocks, loadCandidates, loadLibraryItem, nextSessionBlock, type LibraryItemView, type LibraryStepView } from "./generate";
import type { PipelineStage } from "./pipeline";
import { warmAheadForSubject } from "./warmup";
import {
  breakDue,
  decideBranch,
  idleAutoPauseDue,
  idleHintDue,
  lessonTimeIsUp,
  looksLikeGuess,
  needsResumeReminder,
  pauseFor,
  shouldSuggestFormatChange,
  type Channel,
  type PauseReason,
  type Verdict,
} from "./state-machine";
import { z } from "zod";

/**
 * Lesson orchestrator (ADR-007): the only place that turns the pure rules in
 * `state-machine.ts` into reads/writes of `lesson_sessions` and friends.
 * Every mutation here is one round trip after one child action — "save
 * after every step" (US-6.5, docs/02 5.2) falls out of that by construction.
 */

interface SubjectRow {
  id: string;
  name_uk: string;
  config: Record<string, unknown>;
}
interface TopicRow {
  id: string;
  title: string;
  grade: number | null;
}
interface SessionRow {
  id: string;
  family_id: string;
  child_profile_id: string;
  subject_id: string;
  topic_id: string;
  mode: string;
  status: string;
  pause_reason: string | null;
  candidate_library_item_ids: string[];
  current_block_order: number;
  current_step_id: string | null;
  active_seconds: number;
  seconds_since_break: number;
  breaks_offered: number;
  breaks_taken: number;
  breaks_skipped: number;
  planned_minutes: number;
  points_earned: number;
  paused_at: string | null;
  /** US-6.16 КП-5: 'voice' | 'auto' | 'text' — the lesson-screen speech-mode switch. */
  presentation_mode: string;
  /** ADR-023: set only while `mode === "warming"` — the `library.warm_topic` job being waited on. */
  warm_job_id: string | null;
}

async function loadSession(familyId: string, sessionId: string): Promise<SessionRow | null> {
  const { data } = await forFamily(familyId)
    .select("lesson_sessions", "*")
    .eq("id", sessionId)
    .maybeSingle<SessionRow>();
  return data;
}

export interface StartCandidate {
  libraryItemId: string;
  title: string;
  estimatedMinutes: number | null;
}

/**
 * US-9.1 КП-2, US-16.6 КП-1: offer 2–3 blocks to start from.
 *
 * BUG-011: if generation could not produce a single approved block (reviewer
 * unavailable, e.g. no `OPENAI_API_KEY`, or every attempt ended
 * `needs_review`), the lesson still **starts** — with the safe, deterministic
 * "простий шаблон" (`getOrCreateFallbackBlock`, US-6.11) as its only
 * candidate — instead of throwing and never creating a session at all. The
 * parent gets a notification naming the actual reason.
 *
 * ADR-023: a topic with zero active blocks ("cold") no longer generates
 * inline here — `getOrGenerateLessonBlocks` hands off to a background
 * `library.warm_topic` job and returns `warmJobId` instead. The session
 * still gets created (so the child has somewhere to land and a URL to poll),
 * just in `mode: "warming"` with no candidates yet; `checkWarmupProgress`
 * below moves it to `choosing` once the job (or the safe fallback template)
 * produces a block.
 */
export async function startLessonSession(
  familyId: string,
  childProfileId: string,
  subjectId: string,
  topicId: string,
  plannedMinutes: 30 | 45,
): Promise<{ sessionId: string; candidates: StartCandidate[]; usedFallback: boolean; warming: boolean }> {
  const scope = forFamily(familyId);
  const [{ data: subject }, { data: topic }] = await Promise.all([
    scope.select("subjects", "id, name_uk, config").eq("id", subjectId).maybeSingle<SubjectRow>(),
    scope.select("topics", "id, title, grade").eq("id", topicId).maybeSingle<TopicRow>(),
  ]);
  if (!subject || !topic) throw new Error("subject or topic not found");

  // ADR-023 §Частина 3.3 (D-103): the child's own progression through the
  // topics of a subject is itself a trigger — opening topic X here warms up
  // the next few topics in sequence (anchored on X, not necessarily the
  // subject's `is_current` one), so a normal linear progression never hits a
  // cold topic. Fire-and-forget: never blocks or fails starting *this*
  // session either way.
  warmAheadForSubject(familyId, subjectId, { anchorTopicId: topicId }).catch((e: Error) =>
    console.error(`library warm-ahead on session start failed: ${e.message}`),
  );

  const { candidates: generated, failureReasonUk, warmJobId } = await getOrGenerateLessonBlocks(
    familyId,
    subject.id,
    subject.name_uk,
    subject.config,
    topic.id,
    topic.title,
    topic.grade,
  );

  if (warmJobId) {
    const { data: warming, error: warmingError } = await scope.client
      .from("lesson_sessions")
      .insert({
        family_id: familyId,
        child_profile_id: childProfileId,
        subject_id: subjectId,
        topic_id: topicId,
        mode: "warming",
        status: "active",
        planned_minutes: plannedMinutes,
        candidate_library_item_ids: [],
        warm_job_id: warmJobId,
      })
      .select("id")
      .single<{ id: string }>();
    if (warmingError || !warming) throw new Error(`starting a warming lesson session failed: ${warmingError?.message}`);
    return { sessionId: warming.id, candidates: [], usedFallback: false, warming: true };
  }

  const usedFallback = generated.length === 0;
  const candidates = usedFallback
    ? [await getOrCreateFallbackBlock(familyId, subject.id, topic.id, topic.title, topic.grade)]
    : generated;

  const { data: session, error } = await scope.client
    .from("lesson_sessions")
    .insert({
      family_id: familyId,
      child_profile_id: childProfileId,
      subject_id: subjectId,
      topic_id: topicId,
      mode: "choosing",
      status: "active",
      planned_minutes: plannedMinutes,
      candidate_library_item_ids: candidates.map((c) => c.id),
    })
    .select("id")
    .single<{ id: string }>();
  if (error || !session) throw new Error(`starting a lesson session failed: ${error?.message}`);

  if (usedFallback) {
    const reason = failureReasonUk ?? "жоден згенерований блок теми не пройшов рецензію";
    await notifyParent(familyId, {
      type: "lesson_started_with_fallback",
      severity: "normal",
      payload: { topicId, topicTitle: topic.title, sessionId: session.id, reason },
    }).catch((e: Error) => console.error(`lesson_started_with_fallback notification failed: ${e.message}`));
  }

  return {
    sessionId: session.id,
    candidates: candidates.map((c) => ({ libraryItemId: c.id, title: c.title, estimatedMinutes: c.estimatedMinutes })),
    usedFallback,
    warming: false,
  };
}

export interface WarmupProgress {
  ready: boolean;
  /** `jobs.payload.stage` while not ready (planning/generating/reviewing/revising/saving). */
  stage: PipelineStage | null;
  /** BUG-035: `jobs.payload.reviewPass` while not ready — the current
   * generate→review pass (1-based), or `null` on stages that have no pass
   * number (planning/saving). */
  reviewPass: number | null;
  usedFallback: boolean;
  candidates: StartCandidate[];
}

/**
 * ADR-023 §Частина 1.7/1.2: polled by the child's progress screen
 * (`LibraryWarmProgress`) while `mode === "warming"`. Moves the session to
 * `choosing` (real candidates, or the safe fallback template) the moment
 * either an active block exists or the warm-up job is done trying — never
 * leaves the child stuck on the progress screen forever.
 */
export async function checkWarmupProgress(familyId: string, sessionId: string): Promise<WarmupProgress> {
  const session = await loadSession(familyId, sessionId);
  if (!session) throw new Error("session not found");
  if (session.mode !== "warming") {
    // Already resolved (e.g. a second poll after the first one moved it on).
    return { ready: true, stage: null, reviewPass: null, usedFallback: false, candidates: [] };
  }

  const scope = forFamily(familyId);
  return resolveWarmupProgress(familyId, scope, session);
}

async function resolveWarmupProgress(familyId: string, scope: ReturnType<typeof forFamily>, session: SessionRow): Promise<WarmupProgress> {
  const activeBlocks = await loadCandidates(scope, session.topic_id, CANDIDATE_TARGET);
  if (activeBlocks.length > 0) {
    const candidateIds = activeBlocks.map((b) => b.id);
    await scope.update("lesson_sessions", { mode: "choosing", candidate_library_item_ids: candidateIds }).eq("id", session.id);
    return {
      ready: true,
      stage: null,
      reviewPass: null,
      usedFallback: false,
      candidates: activeBlocks.map((b) => ({ libraryItemId: b.id, title: b.title, estimatedMinutes: b.estimated_minutes })),
    };
  }

  const db = createServiceClient();
  const { data: job } = session.warm_job_id
    ? await db
        .from("jobs")
        .select("status, payload")
        .eq("id", session.warm_job_id)
        .maybeSingle<{ status: string; payload: { stage?: PipelineStage; reviewPass?: number | null } }>()
    : { data: null };

  if (!job || job.status === "failed" || job.status === "done") {
    const { data: topic } = await scope.select("topics", "id, title, grade").eq("id", session.topic_id).maybeSingle<TopicRow>();
    const fallback = await getOrCreateFallbackBlock(familyId, session.subject_id, session.topic_id, topic?.title ?? "", topic?.grade ?? null);
    await scope.update("lesson_sessions", { mode: "choosing", candidate_library_item_ids: [fallback.id] }).eq("id", session.id);
    if (job?.status === "failed") {
      await notifyParent(familyId, {
        type: "lesson_started_with_fallback",
        severity: "normal",
        payload: { topicId: session.topic_id, topicTitle: topic?.title ?? "", sessionId: session.id, reason: "фонове прогрівання не завершилось успіхом" },
      }).catch((e: Error) => console.error(`lesson_started_with_fallback notification failed: ${e.message}`));
    }
    return {
      ready: true,
      stage: null,
      reviewPass: null,
      usedFallback: true,
      candidates: [{ libraryItemId: fallback.id, title: fallback.title, estimatedMinutes: fallback.estimatedMinutes }],
    };
  }

  return {
    ready: false,
    stage: job.payload?.stage ?? "planning",
    reviewPass: job.payload?.reviewPass ?? null,
    usedFallback: false,
    candidates: [],
  };
}

/**
 * BUG-016: neither write here was error-checked — a rejected insert/update
 * (e.g. a duplicate `(session_id, sort_order)` from a retried click) used to
 * be silently swallowed, leaving `current_step_id` pointing at a step the
 * next render couldn't find a matching `session_blocks` row for. The child
 * never saw *why* — only Next's generic error page (BUG-016) once the
 * following render hit that mismatch. Both writes are now checked so the
 * failure surfaces as a specific, catchable `Error` instead.
 */
async function activateBlock(familyId: string, session: SessionRow, libraryItemId: string): Promise<LibraryItemView> {
  const scope = forFamily(familyId);
  const item = await loadLibraryItem(familyId, libraryItemId);
  if (!item || item.steps.length === 0) throw new Error("chosen block has no steps");
  const nextOrder = session.current_block_order + 1;
  const { error: blockError } = await scope.client.from("session_blocks").insert({
    family_id: familyId,
    session_id: session.id,
    library_item_id: libraryItemId,
    sort_order: nextOrder,
    status: "active",
  });
  if (blockError) throw new Error(`activating lesson block failed: ${blockError.message}`);
  const { error: sessionError } = await scope.update("lesson_sessions", {
    mode: "lesson",
    status: "active",
    current_block_order: nextOrder,
    current_step_id: item.steps[0]!.id,
  }).eq("id", session.id);
  if (sessionError) throw new Error(`activating lesson block failed: ${sessionError.message}`);
  return item;
}

/** US-16.6 КП-1: the child picks one of the offered blocks; the lesson begins. */
export async function chooseStartBlock(familyId: string, sessionId: string, libraryItemId: string): Promise<LessonStepView> {
  const session = await loadSession(familyId, sessionId);
  if (!session) throw new Error("session not found");
  if (!session.candidate_library_item_ids.includes(libraryItemId)) throw new Error("not an offered block");
  const item = await activateBlock(familyId, session, libraryItemId);
  return stepView(item, item.steps[0]!, 1);
}

export interface LessonStepView {
  stepId: string;
  type: string;
  content: Record<string, unknown>;
  visual: Record<string, unknown>;
  sourceRefs: LibraryStepView["sourceRefs"];
  stepNumber: number;
  totalSteps: number;
}

function stepView(item: LibraryItemView, step: LibraryStepView, stepNumber: number): LessonStepView {
  return { stepId: step.id, type: step.type, content: step.content, visual: step.visual, sourceRefs: step.sourceRefs, stepNumber, totalSteps: item.steps.length };
}

/** Full render view of an active session's current step (for reload / "Продовжити"). */
export async function getLessonView(
  familyId: string,
  sessionId: string,
): Promise<{ session: SessionRow; step: LessonStepView | null; remediation: { explanationUk: string } | null }> {
  const session = await loadSession(familyId, sessionId);
  if (!session) throw new Error("session not found");
  if (!session.current_step_id) return { session, step: null, remediation: null };
  const scope = forFamily(familyId);
  const { data: blockRow } = await scope
    .select("session_blocks", "library_item_id")
    .eq("session_id", sessionId)
    .eq("sort_order", session.current_block_order)
    .maybeSingle<{ library_item_id: string }>();
  if (!blockRow) return { session, step: null, remediation: null };
  const item = await loadLibraryItem(familyId, blockRow.library_item_id);
  if (!item) return { session, step: null, remediation: null };
  const idx = item.steps.findIndex((s) => s.id === session.current_step_id);
  if (idx < 0) return { session, step: null, remediation: null };
  const libStep = item.steps[idx]!;

  // ADR-028 §2: reconstruct "are we mid-remediation" from `step_attempts`
  // alone on every reload/resume (`current_step_id` never records it) —
  // the exact same predicate `submitStepAnswer` computes.
  const { data: attemptRows } = await scope
    .select("step_attempts", "verdict, attempt_no, remediation")
    .eq("session_id", sessionId)
    .eq("step_id", libStep.id)
    .order("attempt_no")
    .returns<{ verdict: Verdict; attempt_no: number; remediation: RemediationCache | null }[]>();
  const attempts = attemptRows ?? [];
  const cache = isRemediationRetryAttempt(attempts) ? attempts[0]!.remediation : null;
  if (cache) {
    const effective = effectiveStepForRemediation(libStep, cache);
    return {
      session,
      step: { stepId: libStep.id, type: libStep.type, content: effective.content, visual: effective.visual, sourceRefs: libStep.sourceRefs, stepNumber: idx + 1, totalSteps: item.steps.length },
      remediation: { explanationUk: cache.explanationUk },
    };
  }
  return { session, step: stepView(item, libStep, idx + 1), remediation: null };
}

const evalVerdictSchema = z.object({ verdict: z.enum(["correct", "partial", "incorrect"]), explanationUk: z.string().min(1).max(300) });

/**
 * BUG-019: strips everything that carries no meaning for *matching* an
 * answer — case, accents' normalization form, and punctuation used only as
 * list markup ("а)", "1.", quotes, "…") — down to bare words/numbers
 * separated by single spaces. Never used for anything but the substance
 * check below; the child's raw text is still what gets stored and, if this
 * doesn't resolve it, what the model sees.
 */
function normalizeForSubstanceMatch(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLocaleLowerCase("uk-UA")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * BUG-019 root cause (part 1): the open-answer path had no deterministic
 * "this is obviously right" check at all — every answer, however it was
 * written, went straight to an LLM prompt that (per Alex's real examples)
 * graded a bare number ("2") or a lettered list ("а) ... б) ... в) ...")
 * as not matching its own "Еталон" text closely enough, and came back
 * `partial`. A real teacher marks the *result* right regardless of a
 * child writing just the number, just the option letter, or a full
 * sentence — at most a soft note about the preferred format, never a
 * lower verdict. This check catches the common, unambiguous case (the
 * child's whole answer, once format-only differences are stripped, IS the
 * reference answer) without ever needing the model to resist over-literal
 * template matching; whatever it can't resolve this way still goes to
 * `answer_evaluation` below, whose prompt was rewritten for the same
 * reason (part 2).
 *
 * BUG-021 fix: the original version of this check also accepted the
 * child's answer as a *partial* word-run appearing anywhere inside a
 * longer reference answer ("Тарас" matching inside "Тарас Шевченко",
 * "сонця" matching inside "Земля обертається навколо Сонця") — crediting a
 * single guessed/copied word as a full, correct answer with no coverage
 * threshold at all. The only case where a short answer that ISN'T the
 * whole reference sentence is still unambiguously safe to fast-path is a
 * bare number matching the corresponding number inside the reference
 * ("2" against "Правильна відповідь — 2.") — unlike a word or a name, a
 * lone number can't be "half a fact" the way a fragment of a sentence can,
 * which is exactly the BUG-019 case this fast path exists for. Every other
 * partial/substring match (anything containing a letter) now always goes
 * to the LLM evaluator below, whose prompt already grades short-but-COMPLETE
 * answers as `correct` while catching an incomplete fragment as `partial`.
 */
function matchesExpectedBySubstance(answerText: string, expectedAnswerUk: string): boolean {
  const answer = normalizeForSubstanceMatch(answerText);
  const expected = normalizeForSubstanceMatch(expectedAnswerUk);
  if (!answer || !expected) return false;
  if (answer === expected) return true;
  const answerWords = answer.split(" ");
  if (!answerWords.every((w) => /^\d+$/.test(w))) return false; // BUG-021: no word/letter fragments past this point
  const expectedWords = expected.split(" ");
  for (let i = 0; i + answerWords.length <= expectedWords.length; i++) {
    if (expectedWords.slice(i, i + answerWords.length).join(" ") === answer) return true;
  }
  return false;
}

/**
 * BUG-022 fix: a lesson step with several lettered sub-parts (а/б/в), each
 * with its own expected numeric result ("а) 800:2=400 км, б) 800:4=200 км,
 * в) 800:4·3=600 км"), was graded as ONE reference string — so a child who
 * gave all three correct final numbers ("400, 200 і 600") but didn't write
 * out the division expression itself never matched it (neither the
 * word-substance fast path above, nor, per the real production example in
 * the bug report, the LLM prompt, which read the reference's expressions as
 * required content rather than optional working-out). Per PO decision
 * (P-H, D-74): requiring the written-out expression for arithmetic a child
 * can do in their head is not acceptable — only the final results matter.
 *
 * Per D-75 (PO's explicit two-stage clarification): this is Stage 1 only —
 * the blocking result check — and it deliberately never looks at whether an
 * expression/method was written at all, let alone whether one shown is
 * optimal; that's Stage 2, a separate, non-blocking, optional "friendlier
 * method exists" tip that is out of scope for this fix (deferred, like
 * BUG-019 deferred the explain-cycle, to a future increment — see US-6.15).
 *
 * This recognizes the reference answer's lettered parts, takes each part's
 * *last* number as that part's expected result (the expression's own
 * intermediate numbers come first, the result comes last — "800:2=400" ->
 * 400), and compares them positionally against every number the child's
 * answer contains, in order — regardless of whether the child also wrote
 * the expression. It only ever returns `true` (an exact, unambiguous
 * match); anything it can't confidently parse (fewer than two lettered
 * parts, a part with no number, a different count of numbers than parts)
 * falls through to the LLM evaluator as before.
 */
function extractExpectedPartResults(expectedAnswerUk: string): number[] | null {
  const text = expectedAnswerUk.normalize("NFKC").toLocaleLowerCase("uk-UA");
  const markerRe = /(?:^|[\s,;])(\p{L})\)/gu;
  const markers = [...text.matchAll(markerRe)];
  if (markers.length < 2) return null;
  const numberRe = /\d+(?:[.,]\d+)?/g;
  const results: number[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i]!.index! + markers[i]![0].length;
    const end = i + 1 < markers.length ? markers[i + 1]!.index! : text.length;
    const partNumbers = [...text.slice(start, end).matchAll(numberRe)];
    if (partNumbers.length === 0) return null; // can't confidently identify this part's result
    results.push(Number(partNumbers.at(-1)![0].replace(",", ".")));
  }
  return results;
}

function extractNumbersInOrder(text: string): number[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(",", ".")));
}

function matchesMultiPartFinalNumbers(answerText: string, expectedAnswerUk: string): boolean {
  const expectedResults = extractExpectedPartResults(expectedAnswerUk);
  if (!expectedResults) return false;
  const answerNumbers = extractNumbersInOrder(answerText);
  if (answerNumbers.length !== expectedResults.length) return false;
  return expectedResults.every((n, i) => n === answerNumbers[i]);
}

/**
 * BUG-019 root cause (part 2): the old prompt just handed the model a
 * one-line instruction and an "Еталон" (reference) string, with nothing
 * telling it that the reference is an *example* of a right answer, not a
 * template the child must match — so it graded down for format (a number
 * instead of a sentence, an option letter instead of spelling the option
 * out) as if that were a content mistake. This system prompt is explicit
 * about grading substance only, the way a real teacher would.
 *
 * D-75 fix (BUG-022, PO clarification after the fix's first pass): grading
 * is explicitly two-stage now. Stage 1 (blocking) is the final result only
 * — including for multi-part (а/б/в) questions that ask to "write the
 * expression/дію for each case": if every final number is right, the step
 * is `correct`, full stop, even with zero working shown. Stage 2 (never
 * blocking) only applies when the child DID show their method: an
 * inefficient-but-correct method (PO's own example: dividing 800 by 4
 * directly instead of noticing it halves cleanly twice) must never lower
 * the verdict or ask for a redo — at most a friendly, optional "до речі,
 * є ще швидший спосіб…" aside in the explanation, never a requirement.
 */
export const OPEN_ANSWER_EVALUATION_SYSTEM_UK = [
  "Оціни відповідь дитини на відкрите питання уроку: `correct` (правильно по суті),",
  "`partial` (частково правильно/неповно) або `incorrect` (неправильно по суті).",
  "«Еталон» — це ОРІЄНТОВНА правильна відповідь для довідки, а НЕ шаблон, який",
  "дитина мусить повторити слово в слово чи в тій самій формі. Онови ЗМІСТ і",
  "правильність результату в контексті питання, а не форму запису: коротка",
  "відповідь (просто число, просто літера варіанту «а)/б)/в)», кілька слів)",
  "рахується як `correct`, якщо результат по суті вірний — так само, як",
  "розгорнуте речення. НІКОЛИ не знижуй оцінку лише за формат чи довжину",
  "запису (як реальний вчитель — за відсутність повного речення максимум",
  "легка примітка в поясненні, ніколи не нижчий вердикт).",
  "Двоетапна оцінка (D-75): ЕТАП 1 (блокує вердикт) — лише кінцевий",
  "результат/число. Якщо крок питає кілька підпунктів (а/б/в) і всі кінцеві",
  "числа правильні — це `correct`, НАВІТЬ якщо дитина не розписала сам вираз",
  "чи дію (наприклад «400, 200 і 600» замість «800:2=400, 800:4=200,",
  "800:4·3=600»); ніколи не вимагай переробити чи дописати дію для",
  "`correct` — навіть коли умова кроку явно просить «запиши дію». ЕТАП 2",
  "(ніколи не блокує) — лише якщо дитина сама показала спосіб/дію: якщо він",
  "правильний, але неоптимальний (наприклад ділить 800 навпіл, а не двічі",
  "навпіл), не знижуй оцінку й не проси переробити — щонайбільше додай у",
  "поясненні одну доброзичливу необов'язкову репліку на кшталт «до речі, є",
  "ще швидший спосіб: ...». `partial` — тільки коли сам РЕЗУЛЬТАТ неповний",
  "чи частково вірний по суті. Пояснення — тепле й конкретне.",
  "D-93 (BUG-030): те саме поширюється на ТВОРЧІ/ВІДКРИТІ завдання з",
  "кількома очікуваними елементами розуміння (наприклад, мінітаблиця з",
  "кількох прикладів, у кожного своє пояснення) — не лише на прості числові",
  "підпункти а/б/в. Якщо дитина правильно охопила ВСІ ОСНОВНІ очікувані",
  "елементи (наприклад, кожен приклад із мінітаблиці — з власною, творчою і",
  "по суті коректною інтерпретацією), а пропустила лише ОДИН",
  "другорядний/пояснювальний нюанс (наприклад, метапояснення, ЧОМУ саме",
  "один з елементів математично особливий) — вердикт `correct`, НІКОЛИ",
  "`partial`, і НІКОЛИ тон «Майже! Спробуй ще раз» чи вимога переробити для",
  "відповіді, яка вже по суті правильна. Пропущений нюанс подай як окрему,",
  "доброзичливу, НЕ блокуючу пропозицію в кінці пояснення (на кшталт «А ще",
  "можеш подумати, чому...» чи «До речі, а знаєш, чому...») — так само, як",
  "ЕТАП 2 вище, а не як умову для нової спроби. Де це природно, сформулюй",
  "таку необов'язкову пропозицію у форматі вибору з варіантів (наприклад",
  "«це (а)... (б)... чи (в)...?»), а не як вимогу дописати ще вільний",
  "текст — дитині простіше й приємніше обрати варіант, ніж формулювати",
  "нове пояснення з нуля. `partial` для творчого завдання лишається лише",
  "тоді, коли дитина справді пропустила чи переплутала один з ОСНОВНИХ",
  "очікуваних елементів (наприклад, дала два приклади замість трьох, чи не",
  "дала жодного пояснення до жодного з них), а не за відсутність одного",
  "другорядного пояснювального нюансу.",
].join(" ");

/**
 * ADR-028 §2 (US-6.15): cached, on `step_attempts.remediation`, only for the
 * attempt that STARTS the "explain -> reinforce" cycle (attempt 1,
 * non-correct, step has remediation content) — makes the cycle idempotent
 * across a reload/resume (and for `open` steps, avoids ever calling the
 * live model twice for the same wrong attempt).
 */
export interface RemediationCache {
  explanationUk: string;
  /** Index into `content.remediation.retryVariants` — always 0 in the MVP
   * (ВП-35: exactly one cycle), kept as an index rather than a hard-coded 0
   * so a future multi-pass-through-the-library rotation (out of this ADR's
   * scope) has somewhere to write a different value without a new column. */
  retryVariantIndex: number;
  source: "cached" | "live";
  /** `interactive` steps only: the deterministically regenerated `props`
   * for the retry — cached (not just recomputed from `seed` again) so a
   * reload shows literally the same retry, not a fresh call to `regenerate`
   * that *should* be identical but is never assumed to be. */
  retryProps?: Record<string, unknown>;
}

/**
 * ADR-028 §1: does this step carry remediation content at all? A step
 * generated before this ADR (or an interactive component with no
 * `regenerate()`) has none — the caller degrades to today's plain
 * `alt_explanation` retry, unchanged (ВП-37).
 */
function stepHasRemediationContent(step: LibraryStepView): boolean {
  if (step.type === "choice") {
    const options = (step.content.options as { misconceptionUk?: string }[] | undefined) ?? [];
    const variants = (step.content.remediation as { retryVariants?: unknown[] } | undefined)?.retryVariants ?? [];
    return variants.length > 0 && options.some((o) => !!o.misconceptionUk);
  }
  if (step.type === "open") {
    const variants = (step.content.remediation as { retryVariants?: unknown[] } | undefined)?.retryVariants ?? [];
    return variants.length > 0;
  }
  if (step.type === "interactive") {
    const hasRetry = !!(step.visual.remediation as { hasRetry?: boolean } | undefined)?.hasRetry;
    const def = getLessonComponent(step.visual.component as string);
    return hasRetry && !!def?.regenerate;
  }
  return false;
}

/**
 * ADR-028 §2: the SAME predicate `decideBranch` already uses to count
 * consecutive failures — "is this the 2nd attempt of a still-active,
 * 1-cycle remediation loop" is read directly off `step_attempts`, not a new
 * field (docs/adr/028… §2: "remediationActive(session, step) :=
 * count(step_attempts)==1 AND that attempt's verdict != correct").
 */
function isRemediationRetryAttempt(priorAttemptsOnStep: { verdict: Verdict }[]): boolean {
  return priorAttemptsOnStep.length === 1 && priorAttemptsOnStep[0]!.verdict !== "correct";
}

/** Swaps in the cached retry variant/props for evaluating (or displaying) attempt 2 of a remediation cycle. */
function effectiveStepForRemediation(step: LibraryStepView, cache: RemediationCache): LibraryStepView {
  if (step.type === "choice" || step.type === "open") {
    const variants = (step.content.remediation as { retryVariants?: Record<string, unknown>[] } | undefined)?.retryVariants ?? [];
    const variant = variants[cache.retryVariantIndex];
    return variant ? { ...step, content: variant } : step;
  }
  if (step.type === "interactive" && cache.retryProps) {
    return { ...step, visual: { ...step.visual, props: cache.retryProps } };
  }
  return step;
}

/** Where a step sits in its block right now — needed to build the `retryStep` view returned inline (same stepId, ADR-028 §4). */
async function currentStepPosition(familyId: string, session: SessionRow, stepId: string): Promise<{ stepNumber: number; totalSteps: number } | null> {
  const scope = forFamily(familyId);
  const { data: blockRow } = await scope
    .select("session_blocks", "library_item_id")
    .eq("session_id", session.id)
    .eq("sort_order", session.current_block_order)
    .maybeSingle<{ library_item_id: string }>();
  if (!blockRow) return null;
  const item = await loadLibraryItem(familyId, blockRow.library_item_id);
  if (!item) return null;
  const idx = item.steps.findIndex((s) => s.id === stepId);
  return idx < 0 ? null : { stepNumber: idx + 1, totalSteps: item.steps.length };
}

const remediationExplanationSchema = z.object({ explanationUk: z.string().min(1).max(300) });

/**
 * ADR-028 §5 (D-77/78, ADR-023 Part 2 speed tier): "step_reinforcement"
 * (Sonnet 5, scaffolded by ADR-023/S27) — the ONLY case in this whole cycle
 * that needs a genuinely live call: an `open` step's wrong free-text answer
 * can't be pre-cached (КП-1 needs the concrete reason for THIS answer, not
 * a template). One call, no synchronous `lesson_review` in this path.
 */
export const REMEDIATION_EXPLANATION_SYSTEM_UK =
  "Поясни дитині ОДНИМ-двома реченнями, у чому саме конкретна помилка в її відповіді на це питання уроку — " +
  "тепло, доброзичливо, без осуду і без загальних фраз на кшталт «спробуй ще раз» чи «майже» — назви ЩО САМЕ " +
  "не так (яке правило застосовано невірно, яка частина відповіді розходиться з очікуваною).";

async function liveOpenRemediationExplanation(
  familyId: string,
  sessionId: string,
  step: LibraryStepView,
  childAnswerText: string,
): Promise<string | null> {
  try {
    const res = await callStructured(
      "step_reinforcement",
      {
        system: `${safetyPreambleGenericUk()}\n\n${REMEDIATION_EXPLANATION_SYSTEM_UK}`,
        prompt: `Питання: ${step.content.questionUk}\nЕталон (орієнтовно): ${step.content.expectedAnswerUk}\nРубрика: ${step.content.rubricUk}\nВідповідь дитини: ${childAnswerText}`,
        schema: remediationExplanationSchema,
      },
      { familyId, sessionId },
    );
    return res.result.explanationUk;
  } catch {
    // Never blocks the lesson: the caller degrades to no remediation swap —
    // same as an older step with no remediation content at all (ВП-37).
    return null;
  }
}

/**
 * ADR-028 §2: builds the remediation package for the attempt that STARTS
 * the cycle (first non-correct attempt at a step carrying remediation
 * content). `choice`/`interactive` are zero-AI-call (cached/deterministic,
 * D-77/78); `open` makes exactly the one live call above. Returns `null`
 * when the step has no usable remediation content for the answer actually
 * given — the caller falls back to today's plain retry (ВП-37), never
 * throws or blocks the lesson.
 */
async function buildRemediation(
  familyId: string,
  sessionId: string,
  step: LibraryStepView,
  answer: unknown,
): Promise<{ cache: RemediationCache; explanationUk: string } | null> {
  if (step.type === "choice") {
    const chosenOptionId = (answer as { optionId?: string } | null)?.optionId ?? null;
    const options = (step.content.options as { id: string; misconceptionUk?: string }[] | undefined) ?? [];
    const variants = (step.content.remediation as { retryVariants?: unknown[] } | undefined)?.retryVariants ?? [];
    const chosen = options.find((o) => o.id === chosenOptionId);
    if (!chosen?.misconceptionUk || variants.length === 0) return null;
    return { cache: { explanationUk: chosen.misconceptionUk, retryVariantIndex: 0, source: "cached" }, explanationUk: chosen.misconceptionUk };
  }
  if (step.type === "open") {
    const variants = (step.content.remediation as { retryVariants?: unknown[] } | undefined)?.retryVariants ?? [];
    if (variants.length === 0) return null;
    const openText = typeof (answer as { text?: unknown } | null)?.text === "string" ? (answer as { text: string }).text : String(answer ?? "");
    const explanationUk = await liveOpenRemediationExplanation(familyId, sessionId, step, openText);
    if (!explanationUk) return null;
    return { cache: { explanationUk, retryVariantIndex: 0, source: "live" }, explanationUk };
  }
  if (step.type === "interactive") {
    const hasRetry = !!(step.visual.remediation as { hasRetry?: boolean } | undefined)?.hasRetry;
    const def = getLessonComponent(step.visual.component as string);
    if (!hasRetry || !def?.regenerate) return null;
    const verdict = def.evaluate(step.visual.props as never, answer as never);
    const explanationUk = def.describe(step.visual.props as never, verdict);
    const seed = `${sessionId}:${step.id}:2`;
    const retryProps = def.regenerate(step.visual.props as never, seed) as Record<string, unknown>;
    return { cache: { explanationUk, retryVariantIndex: 0, source: "cached", retryProps }, explanationUk };
  }
  return null;
}

/**
 * ADR-028 §2 КП-3: the soft fallback answer-reveal shown once the cycle's
 * one reinforcement attempt has ALSO failed — assembled with zero AI calls
 * from fields the ORIGINAL step already carries (never the retry variant).
 */
function buildFallbackText(step: LibraryStepView): string | null {
  if (step.type === "choice") {
    const options = (step.content.options as { id: string; textUk: string }[] | undefined) ?? [];
    const correct = options.find((o) => o.id === step.content.correctOptionId);
    if (!correct) return null;
    const explanationUk = String(step.content.explanationUk ?? "");
    return explanationUk ? `${correct.textUk} — ${explanationUk}` : correct.textUk;
  }
  if (step.type === "open") {
    const expected = String(step.content.expectedAnswerUk ?? "");
    return expected || null;
  }
  if (step.type === "interactive") {
    const text = String(step.visual.fallback_text ?? "");
    return text || null;
  }
  return null;
}

async function evaluateAnswer(
  familyId: string,
  sessionId: string,
  step: LibraryStepView,
  channel: Channel,
  answer: unknown,
): Promise<{ verdict: Verdict; explanation: string }> {
  if (step.type === "choice") {
    const chosen = (answer as { optionId?: string } | null)?.optionId;
    const correct = chosen === (step.content.correctOptionId as string);
    return { verdict: correct ? "correct" : "incorrect", explanation: String(step.content.explanationUk ?? "") };
  }
  if (step.type === "interactive") {
    const def = getLessonComponent(step.visual.component as string);
    if (!def) return { verdict: "incorrect", explanation: "" };
    const result = def.evaluate(step.visual.props as never, answer as never);
    return { verdict: result.correct ? "correct" : "incorrect", explanation: def.describe(step.visual.props as never, result) };
  }
  // "open": no exact answer on the device — ask the evaluation role (US-6.2 КП-1).
  const openAnswerText = typeof (answer as { text?: unknown } | null)?.text === "string" ? (answer as { text: string }).text : String(answer ?? "");
  const expectedAnswerUk = String(step.content.expectedAnswerUk ?? "");
  if (
    expectedAnswerUk &&
    (matchesExpectedBySubstance(openAnswerText, expectedAnswerUk) || matchesMultiPartFinalNumbers(openAnswerText, expectedAnswerUk))
  ) {
    return { verdict: "correct", explanation: uk.child.lesson.openAnswerCorrectGeneric };
  }
  try {
    const res = await callStructured(
      "answer_evaluation",
      {
        system: `${safetyPreambleGenericUk()}\n\n${OPEN_ANSWER_EVALUATION_SYSTEM_UK}`,
        prompt: `Питання: ${step.content.questionUk}\nЕталон (орієнтовна відповідь, не шаблон для копіювання): ${step.content.expectedAnswerUk}\nРубрика: ${step.content.rubricUk}\nВідповідь дитини: ${openAnswerText}`,
        schema: evalVerdictSchema,
      },
      { familyId, sessionId },
    );
    return { verdict: res.result.verdict, explanation: res.result.explanationUk };
  } catch {
    // Never blocks the lesson (ADR-007): unresolved answers count as "partial" for review later.
    return { verdict: "partial", explanation: "Записали твою відповідь — переглянемо разом із татом." };
  }
}

export interface AnswerResult {
  verdict: Verdict;
  explanation: string;
  formatChangeSuggested: boolean;
  /**
   * ADR-028/US-6.15: set exactly when this attempt started (or, on an
   * idempotent replay, re-shows) the "explain -> reinforce" cycle.
   * `retryStep` is rendered INLINE in place of the current step's own
   * content/visual (same `stepId`, `stepNumber`/`totalSteps` unchanged) —
   * never a modal, never a new step — so the nav rail/pause/BUG-013
   * override all keep working completely unmodified (ADR-028 §4).
   */
  remediation: { explanationUk: string; retryStep: LessonStepView } | null;
  /**
   * ADR-028/US-6.15 КП-3: set when the cycle's one reinforcement attempt
   * ALSO failed — the soft answer-reveal, shown once before the lesson
   * moves on (`next` below is already the following step/block).
   */
  fallback: { textUk: string } | null;
  next:
    | { kind: "retry_step" }
    | { kind: "advance"; step: LessonStepView | null }
    /** US-6.13: shown between blocks, before the next one (or the lesson) starts. */
    | { kind: "block_complete"; libraryItemId: string; visibleOutcomeUk: string | null }
    | { kind: "lesson_complete" };
}

/**
 * One answer -> evaluate -> branch -> save (US-6.5: after every step).
 * `idempotencyKey` makes a resend (after reconnecting, US-6.5 КП-2) a no-op.
 */
export async function submitStepAnswer(
  familyId: string,
  sessionId: string,
  stepId: string,
  idempotencyKey: string,
  channel: Channel,
  answer: unknown,
  latencyMs: number | null,
): Promise<AnswerResult> {
  const scope = forFamily(familyId);
  const session = await loadSession(familyId, sessionId);
  if (!session || session.current_step_id !== stepId) throw new Error("stale step — reload the session");

  const { data: existing } = await scope
    .select("step_attempts", "*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle<{ verdict: Verdict; remediation: RemediationCache | null }>();
  const { data: stepRow } = await scope
    .select("library_steps", "id, type, content, visual, source_refs")
    .eq("id", stepId)
    .maybeSingle<{ id: string; type: string; content: Record<string, unknown>; visual: Record<string, unknown>; source_refs: LibraryStepView["sourceRefs"] }>();
  if (!stepRow) throw new Error("step not found");
  const step: LibraryStepView = { id: stepRow.id, sortOrder: 0, type: stepRow.type, content: stepRow.content, visual: stepRow.visual, sourceRefs: stepRow.source_refs };

  const { data: priorRows } = await scope
    .select("step_attempts", "verdict, attempt_no, guess_flag, remediation")
    .eq("session_id", sessionId)
    .eq("step_id", stepId)
    .order("attempt_no")
    .returns<{ verdict: Verdict; attempt_no: number; guess_flag: boolean; remediation: RemediationCache | null }[]>();
  const priorAttempts = priorRows ?? [];
  const attemptNo = existing ? (priorAttempts.at(-1)?.attempt_no ?? 1) : priorAttempts.length + 1;

  // ADR-028 §2: "are we on attempt 2 of a still-active remediation cycle" —
  // read BEFORE evaluating, because attempt 2 must be graded against the
  // cached retry variant/props, never the original step content again.
  const remediationRetryNow = isRemediationRetryAttempt(priorAttempts) && stepHasRemediationContent(step);
  const remediationCacheFromFirstAttempt = remediationRetryNow ? priorAttempts[0]!.remediation : null;
  const evalStep = remediationCacheFromFirstAttempt ? effectiveStepForRemediation(step, remediationCacheFromFirstAttempt) : step;

  // NFR-SAFE-4, US-12.1: an open-question free-text answer is moderated like
  // any other reply from the child, once per real (non-idempotent-replay)
  // submission, in parallel with evaluating it (ADR-009 §4 — no added latency).
  const openText = step.type === "open" && typeof (answer as { text?: unknown } | null)?.text === "string" ? (answer as { text: string }).text : null;
  const moderationPromise = !existing && openText ? moderateMessage({ familyId, sessionId, mode: "lesson", message: openText }) : null;

  let { verdict, explanation } = existing ? { verdict: existing.verdict, explanation: "" } : await evaluateAnswer(familyId, sessionId, evalStep, channel, answer);

  // ADR-028 §5/КП-6: whenever moderation forces the deterministic go-to-dad
  // reply, the remediation cycle (starting OR finishing) must never run —
  // "без винятків", exactly like every other safety-override case. This is
  // the ONLY guard the whole feature adds around BUG-013's existing code
  // below, which is otherwise untouched.
  let moderationForcedUrgent = false;

  if (moderationPromise) {
    const moderation = await moderationPromise;
    await recordSafetyEvent(familyId, session.child_profile_id, "lesson", openText!, moderation, { sessionId }).catch((e: Error) =>
      console.error(`recordSafetyEvent (lesson) failed: ${e.message}`),
    );
    // BUG-013 fix (NFR-SAFE-4, US-12.1 КП-2): same deterministic override as
    // chat.ts/friendChat.ts — the child NEVER sees `answer_evaluation`'s own
    // feedback for an "urgent" reply, no matter what it said. `verdict` is
    // also forced away from "correct" so `decideBranch` cannot skip straight
    // to the next step right after a safety signal (it goes through
    // `alt_explanation` — the child stays on the same step, seeing the
    // go-to-dad message — unless this was already the 2nd consecutive
    // non-correct attempt, in which case it behaves like any other repeated
    // miss, US-6.4, and still advances rather than looping forever).
    if (moderation.severity === "urgent") {
      verdict = "partial";
      explanation = URGENT_REPLY_UK;
      moderationForcedUrgent = true;
    }
  }

  const questionLength = String(evalStep.content.questionUk ?? evalStep.content.textUk ?? "").length;
  const guessFlag = looksLikeGuess(channel, attemptNo, latencyMs, questionLength);

  if (!existing) {
    const { error: insErr } = await scope.client.from("step_attempts").insert({
      family_id: familyId,
      session_id: sessionId,
      step_id: stepId,
      attempt_no: attemptNo,
      answer,
      channel,
      verdict,
      guess_flag: guessFlag,
      latency_ms: latencyMs,
      idempotency_key: idempotencyKey,
    });
    if (insErr && insErr.code !== "23505") throw new Error(`saving the answer failed: ${insErr.message}`);
  }

  const branch = decideBranch({ verdict, attemptNo }, priorAttempts.map((p) => ({ verdict: p.verdict, attemptNo: p.attempt_no })));

  const { data: recentRows } = await scope
    .select("step_attempts", "verdict, guess_flag, created_at")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(3)
    .returns<{ verdict: Verdict; guess_flag: boolean }[]>();
  const formatChangeSuggested = shouldSuggestFormatChange((recentRows ?? []).reverse().map((r) => ({ verdict: r.verdict, guessFlag: r.guess_flag })));

  if (branch.kind === "alt_explanation") {
    // ADR-028 §2: this is the attempt that STARTS (or, on an idempotent
    // replay, re-shows) the "explain -> reinforce" cycle — attempt 1,
    // non-correct, never when moderation already forced the safety phrase
    // (КП-6). `stepHasRemediationContent` degrades an old/plain step to
    // exactly today's behavior (`remediation` stays `null` below).
    let remediation: AnswerResult["remediation"] = null;
    if (attemptNo === 1 && !moderationForcedUrgent && stepHasRemediationContent(step)) {
      const cached = existing?.remediation ?? null;
      const built = cached ? { cache: cached, explanationUk: cached.explanationUk } : await buildRemediation(familyId, sessionId, step, answer);
      if (built) {
        if (!existing) {
          await scope.update("step_attempts", { remediation: built.cache }).eq("idempotency_key", idempotencyKey);
        }
        const pos = await currentStepPosition(familyId, session, stepId);
        if (pos) {
          const effective = effectiveStepForRemediation(step, built.cache);
          remediation = {
            explanationUk: built.explanationUk,
            retryStep: { stepId: step.id, type: step.type, content: effective.content, visual: effective.visual, sourceRefs: step.sourceRefs, stepNumber: pos.stepNumber, totalSteps: pos.totalSteps },
          };
        }
      }
    }
    return { verdict, explanation, formatChangeSuggested, remediation, fallback: null, next: { kind: "retry_step" } };
  }

  // "advance" (skip helpers) or "mark_for_review_and_advance" both move on.
  // ADR-028 §2 КП-3: when this "mark_for_review_and_advance" is specifically
  // the remediation cycle's own 2nd (reinforcement) attempt also failing,
  // attach the soft fallback answer-reveal — never for an ordinary 2nd miss
  // on a step with no remediation content (unchanged US-6.3 КП-2 behavior),
  // and never under a safety override (КП-6).
  const fallback: AnswerResult["fallback"] =
    branch.kind === "mark_for_review_and_advance" && remediationRetryNow && !moderationForcedUrgent
      ? (() => {
          const textUk = buildFallbackText(step);
          return textUk ? { textUk } : null;
        })()
      : null;
  const next = await advanceAfterStep(familyId, session);
  return { verdict, explanation, formatChangeSuggested, remediation: null, fallback, next };
}

async function advanceAfterStep(familyId: string, session: SessionRow): Promise<AnswerResult["next"]> {
  const scope = forFamily(familyId);
  const { data: blockRow } = await scope
    .select("session_blocks", "library_item_id")
    .eq("session_id", session.id)
    .eq("sort_order", session.current_block_order)
    .maybeSingle<{ library_item_id: string }>();
  const item = blockRow ? await loadLibraryItem(familyId, blockRow.library_item_id) : null;
  const idx = item?.steps.findIndex((s) => s.id === session.current_step_id) ?? -1;

  if (item && idx >= 0 && idx + 1 < item.steps.length) {
    const nextStep = item.steps[idx + 1]!;
    await scope.update("lesson_sessions", { current_step_id: nextStep.id }).eq("id", session.id);
    return { kind: "advance", step: stepView(item, nextStep, idx + 2) };
  }

  // Block finished (US-6.4): show the block's visible outcome (US-6.13)
  // before moving on; `continueAfterBlock` decides next block vs. lesson end.
  await scope.update("session_blocks", { status: "done" }).eq("session_id", session.id).eq("sort_order", session.current_block_order);
  return { kind: "block_complete", libraryItemId: blockRow?.library_item_id ?? "", visibleOutcomeUk: item?.visibleOutcomeUk ?? null };
}

/**
 * After the child has seen the block's visible outcome / given feedback
 * (US-6.13), actually moves the session on: ends it if time is up (US-6.7
 * КП-2, never mid-block), otherwise picks the next block.
 *
 * BUG-009 fix: the block picked must not repeat ANY block already used in
 * *this* session (`session_blocks`), not just the one that just finished —
 * `nextSessionBlock` generates one more if the saved library is exhausted
 * within this session, and this ends the lesson early (rather than silently
 * repeat a block) if even that fails.
 */
export async function continueAfterBlock(familyId: string, sessionId: string): Promise<AnswerResult["next"]> {
  const scope = forFamily(familyId);
  const session = await loadSession(familyId, sessionId);
  if (!session) throw new Error("session not found");

  if (lessonTimeIsUp(session.active_seconds, session.planned_minutes)) {
    await scope.update("lesson_sessions", { mode: "summary", status: "completed", completed_at: new Date().toISOString(), current_step_id: null }).eq("id", sessionId);
    return { kind: "lesson_complete" };
  }

  const { data: subject } = await scope.select("subjects", "id, name_uk, config").eq("id", session.subject_id).maybeSingle<SubjectRow>();
  const { data: topic } = await scope.select("topics", "id, title, grade").eq("id", session.topic_id).maybeSingle<TopicRow>();
  if (!subject || !topic) {
    await scope.update("lesson_sessions", { mode: "summary", status: "completed", completed_at: new Date().toISOString(), current_step_id: null }).eq("id", sessionId);
    return { kind: "lesson_complete" };
  }

  const { data: usedRows } = await scope
    .select("session_blocks", "library_item_id")
    .eq("session_id", sessionId)
    .returns<{ library_item_id: string }[]>();
  const usedIds = (usedRows ?? []).map((r) => r.library_item_id);

  const next = await nextSessionBlock(familyId, subject.id, subject.name_uk, subject.config, topic.id, topic.title, topic.grade, usedIds);
  if (!next) {
    await scope.update("lesson_sessions", { mode: "summary", status: "completed", completed_at: new Date().toISOString(), current_step_id: null }).eq("id", sessionId);
    return { kind: "lesson_complete" };
  }
  const nextItem = await activateBlock(familyId, session, next.id);
  return { kind: "advance", step: stepView(nextItem, nextItem.steps[0]!, 1) };
}

/** A `slide` step is a passive explanation (US-6.1): "Далі" advances it without grading or an attempt row. */
export async function acknowledgeSlide(familyId: string, sessionId: string, stepId: string): Promise<AnswerResult["next"]> {
  const session = await loadSession(familyId, sessionId);
  if (!session || session.current_step_id !== stepId) throw new Error("stale step — reload the session");
  return advanceAfterStep(familyId, session);
}

/** US-6.16 КП-5: the child (or a parent configuring ahead) switches how the lesson is presented. */
const PRESENTATION_MODES = new Set(["voice", "auto", "text"]);
export async function setPresentationMode(familyId: string, sessionId: string, mode: string): Promise<void> {
  if (!PRESENTATION_MODES.has(mode)) throw new Error(`invalid presentation_mode "${mode}"`);
  await forFamily(familyId).update("lesson_sessions", { presentation_mode: mode }).eq("id", sessionId);
}

export interface PreviousModuleStepView {
  type: string;
  content: Record<string, unknown>;
}

export interface PreviousModuleView {
  libraryItemId: string;
  title: string;
  steps: PreviousModuleStepView[];
}

/**
 * US-6.16 КП-2: the previously completed block of THIS session, shown
 * read-only (no grading, no AI call, current progress untouched) — the
 * child's own "library preview" of what she just did, one step back.
 * `null` when this is the first block (the button is hidden/disabled then).
 */
export async function getPreviousModuleView(familyId: string, sessionId: string): Promise<PreviousModuleView | null> {
  const session = await loadSession(familyId, sessionId);
  if (!session || session.current_block_order <= 1) return null;
  const scope = forFamily(familyId);
  const { data: blockRow } = await scope
    .select("session_blocks", "library_item_id")
    .eq("session_id", sessionId)
    .eq("sort_order", session.current_block_order - 1)
    .maybeSingle<{ library_item_id: string }>();
  if (!blockRow) return null;
  const item = await loadLibraryItem(familyId, blockRow.library_item_id);
  if (!item) return null;
  return { libraryItemId: item.id, title: item.title, steps: item.steps.map((s) => ({ type: s.type, content: s.content })) };
}

/**
 * BUG-029 (follow-up per PO): real "⬅️" navigation, not just a read-only
 * preview — symmetric to the forward move in `advanceAfterStep`. Moves
 * `current_step_id` back one step WITHIN the current active block only
 * (scope decision below); the child then sees that step exactly as she
 * would moving forward and can submit an answer again through the ordinary
 * `submitStepAnswer` path (no special "re-answer" code needed — it already
 * appends a new `step_attempts` row with the next `attempt_no` for a
 * repeated attempt at the same `step_id`, the same mechanism an
 * `alt_explanation` retry already uses; nothing here overwrites or deletes
 * the earlier attempt, and nothing here touches `points_earned`, which no
 * code path writes yet — see docs/bugs/BUG-029 for why that makes a
 * double-award guard unnecessary for now).
 *
 * Scope decision (documented per the PO's item 4 fallback): only steps
 * already visited in the CURRENT block move this way. `null` at the first
 * step of the active block even when an earlier block exists — going back
 * across a block boundary would need to reopen a `session_blocks` row
 * already marked `done` and could let `continueAfterBlock`/`nextSessionBlock`
 * pick and append an extra, unwanted block on the way back forward (BUG-009's
 * "no block repeats" bookkeeping assumes finished blocks stay finished).
 * `getPreviousModuleView` (read-only, unaffected by this) still covers "what
 * did the previous, already-completed block look like" at that boundary.
 */
export async function goToPreviousStep(familyId: string, sessionId: string): Promise<LessonStepView | null> {
  const scope = forFamily(familyId);
  const session = await loadSession(familyId, sessionId);
  if (!session || !session.current_step_id) return null;
  const { data: blockRow } = await scope
    .select("session_blocks", "library_item_id")
    .eq("session_id", sessionId)
    .eq("sort_order", session.current_block_order)
    .maybeSingle<{ library_item_id: string }>();
  if (!blockRow) return null;
  const item = await loadLibraryItem(familyId, blockRow.library_item_id);
  if (!item) return null;
  const idx = item.steps.findIndex((s) => s.id === session.current_step_id);
  if (idx <= 0) return null; // already the block's first step — nothing earlier IN this block
  const prevStep = item.steps[idx - 1]!;
  await scope.update("lesson_sessions", { current_step_id: prevStep.id }).eq("id", sessionId);
  return stepView(item, prevStep, idx);
}

/**
 * US-12.2 КП-1: a client heartbeat (every ~20 s while the lesson is on
 * screen and not idle) accumulates continuous work time; once it reaches the
 * child's `break_after_minutes` (налашт., default 20), the next answer's
 * `AnswerResult` offers a break instead of silently continuing (docs/02 5.3
 * style: server owns the decision, the client only reports elapsed time).
 */
export async function tickLessonActivity(familyId: string, sessionId: string, deltaSeconds: number): Promise<{ breakOffer: boolean }> {
  const scope = forFamily(familyId);
  const session = await loadSession(familyId, sessionId);
  if (!session || session.status !== "active" || deltaSeconds <= 0) return { breakOffer: false };
  const { data: child } = await scope
    .select("child_profile", "break_after_minutes")
    .eq("id", session.child_profile_id)
    .maybeSingle<{ break_after_minutes: number }>();
  const clampedDelta = Math.min(deltaSeconds, 120);
  const newSinceBreak = session.seconds_since_break + clampedDelta;
  const offer = breakDue(newSinceBreak, child?.break_after_minutes ?? 20);
  await scope
    .update("lesson_sessions", {
      active_seconds: session.active_seconds + clampedDelta,
      // Holds at the trigger point (doesn't keep climbing) until the child
      // resolves the offer (take/skip), so a slow answer doesn't re-offer twice.
      seconds_since_break: offer ? session.seconds_since_break : newSinceBreak,
      ...(offer && session.seconds_since_break < (child?.break_after_minutes ?? 20) * 60 ? { breaks_offered: session.breaks_offered + 1 } : {}),
    })
    .eq("id", sessionId);
  return { breakOffer: offer };
}

/** US-12.2 КП-1/КП-2: "Перерва" — pauses exactly like an alarm/idle pause, resumed the same way. */
export async function takeLessonBreak(familyId: string, sessionId: string): Promise<void> {
  const scope = forFamily(familyId);
  const session = await loadSession(familyId, sessionId);
  if (!session) throw new Error("session not found");
  await scope.update("lesson_sessions", { breaks_taken: session.breaks_taken + 1, seconds_since_break: 0 }).eq("id", sessionId);
  await pauseLessonSession(familyId, sessionId, "break");
}

/** US-12.2 КП-1: "Продовжити без перерви" — logged (US-11.1 daily summary), never blocks. */
export async function skipLessonBreak(familyId: string, sessionId: string): Promise<void> {
  const scope = forFamily(familyId);
  const session = await loadSession(familyId, sessionId);
  if (!session) throw new Error("session not found");
  await scope.update("lesson_sessions", { breaks_skipped: session.breaks_skipped + 1, seconds_since_break: 0 }).eq("id", sessionId);
}

/** US-6.6 (alarm), US-16.4 КП-2 (idle), offline (US-6.5) — always "paused", step kept (docs/02 5.3). */
export async function pauseLessonSession(familyId: string, sessionId: string, reason: PauseReason): Promise<void> {
  const scope = forFamily(familyId);
  await scope
    .update("lesson_sessions", { ...pauseFor(reason), paused_at: new Date().toISOString() })
    .eq("id", sessionId)
    .in("status", ["active"]);
}

export interface ResumeResult {
  step: LessonStepView | null;
  /** US-6.5 КП-3: set when the pause lasted ≥ 24h — shown once, before the step. */
  reminder: { textUk: string } | null;
}

/**
 * US-6.5 КП-1: "Продовжити" reopens the exact step. КП-3 (BUG-008 fix): if
 * the pause lasted 24h or more, also returns a short reminder — the active
 * block's own opening slide, so this costs no new AI call.
 */
export async function resumeLessonSession(familyId: string, sessionId: string): Promise<ResumeResult> {
  const scope = forFamily(familyId);
  const session = await loadSession(familyId, sessionId);
  if (!session) throw new Error("session not found");
  const resumedAt = new Date();
  const wantsReminder = session.paused_at != null && needsResumeReminder(new Date(session.paused_at), resumedAt);

  await scope.update("lesson_sessions", { status: "active", pause_reason: null, resumed_at: resumedAt.toISOString() }).eq("id", sessionId);
  const { step } = await getLessonView(familyId, sessionId);
  if (!wantsReminder || !step) return { step, reminder: null };

  const { data: blockRow } = await scope
    .select("session_blocks", "library_item_id")
    .eq("session_id", sessionId)
    .eq("sort_order", session.current_block_order)
    .maybeSingle<{ library_item_id: string }>();
  const item = blockRow ? await loadLibraryItem(familyId, blockRow.library_item_id) : null;
  const openingSlide = item?.steps.find((s) => s.type === "slide");
  const textUk = openingSlide ? String(openingSlide.content.textUk ?? "") : "";
  return { step, reminder: textUk ? { textUk } : null };
}

export { idleAutoPauseDue, idleHintDue };
