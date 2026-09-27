import "server-only";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { callStructured } from "@/server/ai/router";
import { forFamily, type FamilyScope } from "@/server/db/family-scope";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";
import { safetyPreambleUk } from "@/server/safety/preamble";
import type { TutorGender } from "@/i18n/uk";
import { moderateMessage } from "@/server/safety/moderate";
import type { ModerationResult } from "@/server/safety/classify";
import { recordSafetyEvent } from "@/server/safety/events";
import { URGENT_REPLY_UK } from "@/server/safety/urgentReplyUk";

/**
 * Topic chat (US-8.1, 8.2): one chat per subject+topic per child; answers
 * are grounded in the topic's indexed textbook fragments with page
 * citations. Nickname and tutor name ARE part of this role's context
 * (docs/02 5.4) — real name/e-mail never are (NFR-SAFE-8).
 */
let promptCache: { system: string; user: string } | null = null;
function tutorChatPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "tutor_chat.md"), "utf8"));
  return promptCache;
}

let explainPromptCache: { system: string; user: string } | null = null;
function explainStepPrompt(): { system: string; user: string } {
  explainPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "explain_step.md"), "utf8"));
  return explainPromptCache;
}

// US-8.7 ("поясни задачу №N") — ADR-029 §4 / ADR-028 §3's three-call cycle,
// all `step_reinforcement` (ВП-38, same base model as US-6.15).
let homeworkMethodPromptCache: { system: string; user: string } | null = null;
function homeworkMethodPrompt(): { system: string; user: string } {
  homeworkMethodPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "homework_method.md"), "utf8"));
  return homeworkMethodPromptCache;
}
let homeworkAttemptPromptCache: { system: string; user: string } | null = null;
function homeworkAttemptPrompt(): { system: string; user: string } {
  homeworkAttemptPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "homework_attempt.md"), "utf8"));
  return homeworkAttemptPromptCache;
}
let homeworkFallbackPromptCache: { system: string; user: string } | null = null;
function homeworkFallbackPrompt(): { system: string; user: string } {
  homeworkFallbackPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "homework_fallback.md"), "utf8"));
  return homeworkFallbackPromptCache;
}

const answerSchema = z.object({ answerUk: z.string().min(1).max(1200) });
const explainSchema = z.object({ explanationUk: z.string().min(1).max(900) });

const homeworkMethodSchema = z.object({ methodUk: z.string().min(1).max(900) });
const homeworkAttemptSchema = z.object({
  messageKind: z.enum(["attempt", "give_me_answer_request", "other"]),
  verdict: z.enum(["correct", "incorrect_or_partial"]).nullable(),
  explanationUk: z.string().min(1).max(900),
});
const homeworkFallbackSchema = z.object({ solutionUk: z.string().min(1).max(1200) });

/** ВП-38: 2 attempts after the method explanation, then the full solution (US-8.7 КП-4). */
const MAX_HOMEWORK_ATTEMPTS = 2;

/**
 * ADR-029 §3/§4: state for one "поясни задачу №N" cycle, carried entirely in
 * `messages.meta` (ADR-028's column) — no new table, dispatched purely from
 * this chat's own message history. `anchorId` is this cycle's very first
 * ("method") AI message's own id — every later call in the cycle reuses it
 * as `ai_calls.ref_id` (ADR-029 §4.4's "same anchor for the whole cycle") and
 * as the row to re-read the method text from.
 */
interface HomeworkMeta {
  kind: "homework_problem";
  problemNumber: string;
  materialId: string;
  page: number;
  stage: "method" | "attempt_feedback" | "fallback" | "solved";
  attemptNo: number;
  anchorId: string;
}

function isHomeworkMeta(meta: unknown): meta is HomeworkMeta {
  return !!meta && typeof meta === "object" && (meta as { kind?: unknown }).kind === "homework_problem";
}

interface ChatChunkRow {
  page: number | null;
  text: string;
  materials: { title: string | null; name: string; kind: string } | { title: string | null; name: string; kind: string }[] | null;
}

export interface ChatMessageView {
  id: string;
  author: "child" | "ai" | "system" | "parent";
  content: string;
  createdAt: string;
}

async function getOrCreateChat(familyId: string, childProfileId: string, subjectId: string, topicId: string): Promise<string> {
  const scope = forFamily(familyId);
  const { data: existing } = await scope
    .select("chats", "id")
    .eq("child_profile_id", childProfileId)
    .eq("topic_id", topicId)
    .maybeSingle<{ id: string }>();
  if (existing) return existing.id;
  const { data, error } = await scope.client
    .from("chats")
    .insert({ family_id: familyId, child_profile_id: childProfileId, kind: "subject_topic", subject_id: subjectId, topic_id: topicId })
    .select("id")
    .single<{ id: string }>();
  if (error || !data) throw new Error(`creating the topic chat failed: ${error?.message}`);
  return data.id;
}

// ---------------------------------------------------------------------------
// US-8.7 ("поясни задачу №N") — ADR-029 §4
// ---------------------------------------------------------------------------

export interface ProblemRequest {
  number: string;
  page?: number;
}

/** US-8.7 КП-7: strips the leading "№" a child may type — literal cleanup only, never a guess. */
export function normalizeProblemNumber(raw: string): string {
  return raw.trim().replace(/^№\s*/, "").slice(0, 12);
}

const PROBLEM_NUMBER_RE = /(?:№\s*|задач[ауі]\s*(?:№\s*)?|вправ[ауи]\s*(?:№\s*)?|номер\s*(?:№\s*)?)(\d{1,3}[a-zа-яіїєґ]?)/iu;
const PAGE_RE = /(?:стор(?:інк[аи])?\.?\s*|с\.\s*)(\d{1,4})/iu;

/**
 * Heuristic detector for a "поясни задачу №117" style request (US-8.7 КП-1):
 * only ever an EXPLICIT, literal number the child actually typed — this is
 * about recognizing the request, never about guessing which problem is
 * meant (that exactness lives entirely in `resolveProblemRef` below, КП-7).
 * A message with no such pattern (an ordinary question) returns `null`, and
 * the caller falls through to the plain Q&A path unchanged.
 */
export function extractProblemRequest(text: string): ProblemRequest | null {
  const m = PROBLEM_NUMBER_RE.exec(text);
  if (!m) return null;
  const number = normalizeProblemNumber(m[1]!);
  if (!number) return null;
  const pageMatch = PAGE_RE.exec(text);
  return pageMatch ? { number, page: Number(pageMatch[1]) } : { number };
}

export interface ProblemRef {
  materialId: string;
  materialTitle: string;
  page: number;
  topicId: string | null;
}
export type ResolveProblemOutcome = { kind: "found"; ref: ProblemRef } | { kind: "ambiguous" | "not_found" };

interface ProblemRow {
  material_id: string;
  page: number;
  topic_id: string | null;
}

async function queryProblemsByTopic(scope: FamilyScope, topicId: string, number: string, page?: number): Promise<ProblemRow[]> {
  let q = scope.select("material_problems", "material_id, page, topic_id").eq("topic_id", topicId).eq("number", number);
  if (page != null) q = q.eq("page", page);
  const { data } = await q.returns<ProblemRow[]>();
  return data ?? [];
}

async function queryProblemsBySubject(scope: FamilyScope, subjectId: string, number: string, page?: number): Promise<ProblemRow[]> {
  const { data: materials } = await scope.select("materials", "id").eq("subject_id", subjectId).returns<{ id: string }[]>();
  const materialIds = (materials ?? []).map((m) => m.id);
  if (materialIds.length === 0) return [];
  let q = scope.select("material_problems", "material_id, page, topic_id").in("material_id", materialIds).eq("number", number);
  if (page != null) q = q.eq("page", page);
  const { data } = await q.returns<ProblemRow[]>();
  return data ?? [];
}

async function toProblemRef(scope: FamilyScope, row: ProblemRow): Promise<ProblemRef> {
  const { data } = await scope.select("materials", "title, name").eq("id", row.material_id).maybeSingle<{ title: string | null; name: string }>();
  return { materialId: row.material_id, materialTitle: data?.title ?? data?.name ?? "Підручник", page: row.page, topicId: row.topic_id };
}

/**
 * US-8.7 КП-7 / ADR-029 §4.1: an EXACT lookup, never fuzzy — first scoped to
 * the chat's own topic (the common "ДЗ по щойно пройденій темі" case), then
 * widened to the whole subject (a problem could be indexed under a
 * different topic's page range than the one currently open) — still an
 * exact number(+page) match at every step, only the scope widens. 0 or > 1
 * matches at EITHER step means the caller asks for the page instead of
 * proceeding — the homework cycle never starts on a guess.
 */
export async function resolveProblemRef(
  familyId: string,
  topicId: string,
  subjectId: string,
  rawNumber: string,
  pageHint?: number,
): Promise<ResolveProblemOutcome> {
  const number = normalizeProblemNumber(rawNumber);
  if (!number) return { kind: "not_found" };
  const scope = forFamily(familyId);
  let rows = await queryProblemsByTopic(scope, topicId, number, pageHint);
  if (rows.length === 1) return { kind: "found", ref: await toProblemRef(scope, rows[0]!) };
  if (rows.length > 1) return { kind: "ambiguous" };
  rows = await queryProblemsBySubject(scope, subjectId, number, pageHint);
  if (rows.length === 1) return { kind: "found", ref: await toProblemRef(scope, rows[0]!) };
  return rows.length > 1 ? { kind: "ambiguous" } : { kind: "not_found" };
}

async function findHomeworkByProblemNumber(scope: FamilyScope, chatId: string, number: string): Promise<{ id: string; meta: HomeworkMeta } | null> {
  const { data } = await scope
    .select("messages", "id, meta")
    .eq("chat_id", chatId)
    .eq("author", "ai")
    .eq("meta->>kind", "homework_problem")
    .eq("meta->>problemNumber", number)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; meta: unknown }>();
  return data && isHomeworkMeta(data.meta) ? { id: data.id, meta: data.meta } : null;
}

/** The most recent `homework_problem` AI message of this chat still awaiting the child (any earlier non-homework replies in between — e.g. a safety-override reply — don't end the cycle). */
async function findActiveHomeworkCycle(scope: FamilyScope, chatId: string): Promise<{ id: string; meta: HomeworkMeta } | null> {
  const { data } = await scope
    .select("messages", "id, meta")
    .eq("chat_id", chatId)
    .eq("author", "ai")
    .eq("meta->>kind", "homework_problem")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; meta: unknown }>();
  if (!data || !isHomeworkMeta(data.meta)) return null;
  return data.meta.stage === "method" || data.meta.stage === "attempt_feedback" ? { id: data.id, meta: data.meta } : null;
}

async function saveHomeworkMessage(
  scope: FamilyScope,
  familyId: string,
  chatId: string,
  sessionId: string | undefined,
  content: string,
  meta: HomeworkMeta | Record<string, never>,
  explicitId?: string,
): Promise<ChatMessageView> {
  const { data: saved, error } = await scope.client
    .from("messages")
    .insert({
      ...(explicitId ? { id: explicitId } : {}),
      family_id: familyId,
      chat_id: chatId,
      session_id: sessionId ?? null,
      author: "ai",
      type: "text",
      content,
      meta,
    })
    .select("id, created_at")
    .single<{ id: string; created_at: string }>();
  if (error || !saved) throw new Error(`saving the homework-problem reply failed: ${error?.message}`);
  return { id: saved.id, author: "ai", content, createdAt: saved.created_at };
}

/**
 * ADR-029 §4.1: КП-7's "не вигадує" applies to the request itself, not only
 * the answer — an ambiguous/unresolved number never starts the cycle and
 * never writes `messages.meta` (the caller falls back to today's plain
 * `tutor_chat`-level reply, no live model call needed for this deterministic
 * "перепитай сторінку" branch — D-77/78's "instant, no waiting").
 */
async function startHomeworkProblem(
  scope: FamilyScope,
  familyId: string,
  chatId: string,
  childProfileId: string,
  subjectId: string,
  topicId: string,
  tutorName: string,
  tutorGender: TutorGender,
  requested: ProblemRequest,
  moderation: Promise<ModerationResult>,
  sessionId: string | undefined,
): Promise<ChatMessageView> {
  const resolved = await resolveProblemRef(familyId, topicId, subjectId, requested.number, requested.page);
  const moderationResult = await moderation;
  await recordSafetyEvent(familyId, childProfileId, "tutor_chat", `поясни задачу №${requested.number}`, moderationResult, { sessionId, chatId }).catch(
    (e: Error) => console.error(`recordSafetyEvent (homework_problem) failed: ${e.message}`),
  );
  // BUG-013 / US-8.7 КП-6: the safety override wins outright — no exception
  // for "helping with homework".
  if (moderationResult.severity === "urgent") return saveHomeworkMessage(scope, familyId, chatId, sessionId, URGENT_REPLY_UK, {});

  if (resolved.kind !== "found") {
    return saveHomeworkMessage(
      scope,
      familyId,
      chatId,
      sessionId,
      "Скажи, будь ласка, ще й сторінку підручника — так я зможу точно знайти цю задачу.",
      {},
    );
  }
  const ref = resolved.ref;
  // KП-1/§4.2: the problem's own text comes from already-indexed `chunks` —
  // never invented by the model.
  const { data: chunkRow } = await scope
    .select("chunks", "text")
    .eq("material_id", ref.materialId)
    .eq("page", ref.page)
    .limit(1)
    .maybeSingle<{ text: string }>();
  const problemText = chunkRow?.text ?? "";

  const anchorId = randomUUID();
  const { system, user } = homeworkMethodPrompt();
  const prompt = fillTemplate(user, {
    problem_number: requested.number,
    page: String(ref.page),
    problem_text: problemText || "(текст задачі недоступний)",
  });
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName })}`;
  const methodUk = await callStructured(
    "step_reinforcement",
    { system: system2, prompt, schema: homeworkMethodSchema },
    { familyId, sessionId, ref: { table: "messages", id: anchorId } },
  )
    .then((res) => res.result.methodUk)
    .catch(() => "Зараз не вдалося пояснити метод — спробуй, будь ласка, за хвилинку.");

  const meta: HomeworkMeta = {
    kind: "homework_problem",
    problemNumber: requested.number,
    materialId: ref.materialId,
    page: ref.page,
    stage: "method",
    attemptNo: 0,
    anchorId,
  };
  return saveHomeworkMessage(scope, familyId, chatId, sessionId, methodUk, meta, anchorId);
}

async function homeworkFallbackSolution(
  familyId: string,
  sessionId: string | undefined,
  tutorName: string,
  tutorGender: TutorGender,
  meta: HomeworkMeta,
  problemText: string,
  methodText: string,
): Promise<string> {
  const { system, user } = homeworkFallbackPrompt();
  const prompt = fillTemplate(user, {
    problem_number: meta.problemNumber,
    page: String(meta.page),
    problem_text: problemText || "(текст задачі недоступний)",
    method: methodText || "(метод недоступний)",
  });
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName })}`;
  return callStructured(
    "step_reinforcement",
    { system: system2, prompt, schema: homeworkFallbackSchema },
    { familyId, sessionId, ref: { table: "messages", id: meta.anchorId } },
  )
    .then((res) => res.result.solutionUk)
    .catch(() => "Зараз не вдалося показати розв'язок — спробуй, будь ласка, за хвилинку, або запитай тата.");
}

/**
 * ADR-029 §4.3/§3 (ADR-028): the child's message while a cycle is active —
 * moderation FIRST (BUG-013 / КП-6, no exceptions), then the single
 * `attempt_feedback` call, then the attempt-counting/fallback state machine
 * (ВП-38: 2 attempts before the fallback solution, same pattern ADR-028
 * already built for US-6.15's `step_attempts`-side cycle).
 */
async function continueHomeworkAttempt(
  scope: FamilyScope,
  familyId: string,
  chatId: string,
  childProfileId: string,
  tutorName: string,
  tutorGender: TutorGender,
  active: { id: string; meta: HomeworkMeta },
  cleanQuestion: string,
  moderation: Promise<ModerationResult>,
  sessionId: string | undefined,
): Promise<ChatMessageView> {
  const moderationResult = await moderation;
  await recordSafetyEvent(familyId, childProfileId, "tutor_chat", cleanQuestion, moderationResult, { sessionId, chatId }).catch(
    (e: Error) => console.error(`recordSafetyEvent (homework_problem) failed: ${e.message}`),
  );
  if (moderationResult.severity === "urgent") {
    // BUG-013 / КП-6: overrides outright; the attempt counter is untouched,
    // so the cycle simply continues on the child's next message.
    return saveHomeworkMessage(scope, familyId, chatId, sessionId, URGENT_REPLY_UK, {});
  }

  const { meta } = active;
  const [{ data: chunkRow }, { data: anchorRow }] = await Promise.all([
    scope.select("chunks", "text").eq("material_id", meta.materialId).eq("page", meta.page).limit(1).maybeSingle<{ text: string }>(),
    scope.select("messages", "content").eq("id", meta.anchorId).maybeSingle<{ content: string }>(),
  ]);
  const problemText = chunkRow?.text ?? "";
  const methodText = anchorRow?.content ?? "";

  const { system, user } = homeworkAttemptPrompt();
  const prompt = fillTemplate(user, {
    problem_number: meta.problemNumber,
    page: String(meta.page),
    problem_text: problemText || "(текст задачі недоступний)",
    method: methodText || "(метод недоступний)",
    child_message: cleanQuestion,
  });
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName })}`;
  const outcome = await callStructured(
    "step_reinforcement",
    { system: system2, prompt, schema: homeworkAttemptSchema },
    { familyId, sessionId, ref: { table: "messages", id: meta.anchorId } },
  )
    .then((res) => res.result)
    .catch(() => ({
      messageKind: "other" as const,
      verdict: null,
      explanationUk: "Зараз не вдалося перевірити відповідь — спробуй, будь ласка, ще раз за хвилинку.",
    }));

  if (outcome.messageKind === "attempt" && outcome.verdict === "correct") {
    return saveHomeworkMessage(scope, familyId, chatId, sessionId, outcome.explanationUk, { ...meta, stage: "solved" });
  }
  if (outcome.messageKind === "attempt" && outcome.verdict === "incorrect_or_partial") {
    const attemptNo = meta.attemptNo + 1;
    if (attemptNo < MAX_HOMEWORK_ATTEMPTS) {
      return saveHomeworkMessage(scope, familyId, chatId, sessionId, outcome.explanationUk, { ...meta, stage: "attempt_feedback", attemptNo });
    }
    // ВП-38 / US-8.7 КП-4: attempts exhausted — the full solution, as the
    // LAST step of the dialog, never the first.
    const solutionUk = await homeworkFallbackSolution(familyId, sessionId, tutorName, tutorGender, meta, problemText, methodText);
    return saveHomeworkMessage(scope, familyId, chatId, sessionId, solutionUk, { ...meta, stage: "fallback", attemptNo });
  }
  // "give_me_answer_request" (КП-5) / "other": neither the stage nor the
  // attempt counter move — the cycle just continues.
  return saveHomeworkMessage(scope, familyId, chatId, sessionId, outcome.explanationUk, meta);
}

/**
 * Dispatches one child chat message to the homework-problem cycle when it
 * applies, `null` otherwise (an ordinary US-8.1/8.2 question — the caller
 * falls through to the plain `tutor_chat` path, same chat, same box).
 */
async function homeworkProblemFlow(
  scope: FamilyScope,
  familyId: string,
  chatId: string,
  childProfileId: string,
  subjectId: string,
  topicId: string,
  tutorName: string,
  tutorGender: TutorGender,
  cleanQuestion: string,
  moderation: Promise<ModerationResult>,
  sessionId: string | undefined,
): Promise<ChatMessageView | null> {
  const requested = extractProblemRequest(cleanQuestion);
  if (requested) {
    const existing = await findHomeworkByProblemNumber(scope, chatId, requested.number);
    if (existing && (existing.meta.stage === "method" || existing.meta.stage === "attempt_feedback")) {
      return continueHomeworkAttempt(scope, familyId, chatId, childProfileId, tutorName, tutorGender, existing, cleanQuestion, moderation, sessionId);
    }
    // No cycle yet for this exact number, or an earlier one already ended
    // ("solved"/"fallback") — either way an explicit "№N" always (re)starts
    // that number's own cycle fresh.
    return startHomeworkProblem(scope, familyId, chatId, childProfileId, subjectId, topicId, tutorName, tutorGender, requested, moderation, sessionId);
  }
  const active = await findActiveHomeworkCycle(scope, chatId);
  if (!active) return null;
  return continueHomeworkAttempt(scope, familyId, chatId, childProfileId, tutorName, tutorGender, active, cleanQuestion, moderation, sessionId);
}

export async function listChatMessages(familyId: string, childProfileId: string, subjectId: string, topicId: string): Promise<{ chatId: string; messages: ChatMessageView[] }> {
  const chatId = await getOrCreateChat(familyId, childProfileId, subjectId, topicId);
  const { data } = await forFamily(familyId)
    .select("messages", "id, author, content, created_at")
    .eq("chat_id", chatId)
    .order("created_at")
    .returns<{ id: string; author: ChatMessageView["author"]; content: string; created_at: string }[]>();
  return { chatId, messages: (data ?? []).map((m) => ({ id: m.id, author: m.author, content: m.content, createdAt: m.created_at })) };
}

/** US-8.1 КП-1: answers from the topic's textbook, with a page citation when relevant. */
export async function askTopicChat(
  familyId: string,
  childProfileId: string,
  nickname: string,
  tutorName: string,
  tutorGender: TutorGender,
  subjectId: string,
  subjectName: string,
  topicId: string,
  topicTitle: string,
  question: string,
  sessionId?: string,
): Promise<ChatMessageView> {
  const scope = forFamily(familyId);
  const chatId = await getOrCreateChat(familyId, childProfileId, subjectId, topicId);
  const cleanQuestion = question.trim().slice(0, 800);

  // NFR-SAFE-4, US-12.1: moderate the child's own message before answering it
  // (in parallel with generating the reply — ADR-009 §4 — so this never adds
  // latency the child notices).
  const moderation = moderateMessage({ familyId, sessionId, mode: "tutor_chat", message: cleanQuestion });

  await scope.client.from("messages").insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "child", type: "text", content: cleanQuestion });

  // US-8.7 (ADR-029 §4): "поясни задачу №N" and its follow-ups take priority
  // over the plain Q&A path below — same chat, same message box (ADR-028
  // §3's "без нового виду чату"), dispatched purely from this chat's own
  // `messages.meta` history, never a new table.
  const homework = await homeworkProblemFlow(scope, familyId, chatId, childProfileId, subjectId, topicId, tutorName, tutorGender, cleanQuestion, moderation, sessionId);
  if (homework) return homework;

  const { data: chunkRows } = await scope.client
    .from("chunks")
    .select("page, text, materials(title, name, kind)")
    .eq("owner_family_id", familyId)
    .eq("topic_id", topicId)
    .order("ordinal")
    .limit(12)
    .returns<ChatChunkRow[]>();
  const { data: history } = await scope
    .select("messages", "author, content")
    .eq("chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(20)
    .returns<{ author: string; content: string }[]>();

  const { system, user } = tutorChatPrompt();
  const kindOf = (row: ChatChunkRow) => (Array.isArray(row.materials) ? row.materials[0]?.kind : row.materials?.kind);
  const sorted = [...(chunkRows ?? [])].sort((a, b) => (kindOf(a) === "textbook" ? -1 : 0) - (kindOf(b) === "textbook" ? -1 : 0));
  const prompt = fillTemplate(user, {
    // BUG-010: the textbook is labeled and listed first — the prompt below tells the model it outranks a book.
    fragments:
      sorted
        .map((c) => {
          const m = Array.isArray(c.materials) ? c.materials[0] : c.materials;
          const label = m?.kind === "textbook" ? `ПІДРУЧНИК, стор. ${c.page ?? "—"}` : `КНИГА «${m?.title ?? m?.name ?? "?"}», стор. ${c.page ?? "—"}`;
          return `[${label}]\n${c.text}`;
        })
        .join("\n\n") || "(немає проіндексованих фрагментів цієї теми)",
    history: (history ?? []).reverse().map((m) => `${m.author}: ${m.content}`).join("\n") || "(немає)",
    question: cleanQuestion,
  });
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName, subject_name: subjectName, topic_title: topicTitle, nickname })}`;

  const [moderationResult, answerOutcome] = await Promise.all([
    moderation,
    callStructured("tutor_chat", { system: system2, prompt, schema: answerSchema }, { familyId, sessionId })
      .then((res) => res.result.answerUk)
      .catch(() => null),
  ]);
  await recordSafetyEvent(familyId, childProfileId, "tutor_chat", cleanQuestion, moderationResult, { sessionId, chatId }).catch(
    (e: Error) => console.error(`recordSafetyEvent (tutor_chat) failed: ${e.message}`),
  );
  // NFR-SAFE-4, US-12.1 КП-2: "urgent" always gets the deterministic "go to
  // dad now" reply — never the tutor_chat model's own answer, whatever it
  // said, so this rule cannot be missed or phrased away by the model.
  const answerText =
    moderationResult.severity === "urgent"
      ? URGENT_REPLY_UK
      : (answerOutcome ?? "Зараз не вдалося відповісти — спробуй, будь ласка, ще раз за хвилинку.");

  const { data: saved, error } = await scope.client
    .from("messages")
    .insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "ai", type: "text", content: answerText })
    .select("id, created_at")
    .single<{ id: string; created_at: string }>();
  if (error || !saved) throw new Error(`saving the chat answer failed: ${error?.message}`);
  return { id: saved.id, author: "ai", content: answerText, createdAt: saved.created_at };
}

/**
 * US-6.16 КП-1 ("Пояснити"): an alternative explanation of the CURRENT lesson
 * step, published straight into the same topic chat used for questions (docs/
 * 04 §11.4). Deliberately reuses the light `tutor_chat` quick path (same
 * role/model as `askTopicChat` above) rather than the heavy
 * lesson_planning/generation/review pipeline (D-77's "two speed tiers") —
 * this is not a graded attempt, so no `step_attempts` row and no moderation
 * of the child's own text is needed (there isn't any; only the AI message is
 * posted).
 */
export async function explainStepAgain(
  familyId: string,
  childProfileId: string,
  tutorName: string,
  tutorGender: TutorGender,
  subjectId: string,
  subjectName: string,
  topicId: string,
  topicTitle: string,
  nickname: string,
  stepTextUk: string,
  sessionId?: string,
): Promise<ChatMessageView> {
  const scope = forFamily(familyId);
  const chatId = await getOrCreateChat(familyId, childProfileId, subjectId, topicId);

  const { system, user } = explainStepPrompt();
  const roleNoun = tutorGender === "m" ? "ШІ-помічник" : "ШІ-помічниця";
  const system2 = `${safetyPreambleUk(tutorName, roleNoun)}\n\n${fillTemplate(system, { tutor_name: tutorName, subject_name: subjectName, topic_title: topicTitle, nickname })}`;
  const prompt = fillTemplate(user, { step_text: stepTextUk || "(текст кроку недоступний)" });

  const answerText = await callStructured("tutor_chat", { system: system2, prompt, schema: explainSchema }, { familyId, sessionId })
    .then((res) => res.result.explanationUk)
    .catch(() => "Зараз не вдалося пояснити ще раз — спробуй, будь ласка, за хвилинку, або запитай про це в чаті.");

  const { data: saved, error } = await scope.client
    .from("messages")
    .insert({ family_id: familyId, chat_id: chatId, session_id: sessionId ?? null, author: "ai", type: "text", content: answerText })
    .select("id, created_at")
    .single<{ id: string; created_at: string }>();
  if (error || !saved) throw new Error(`saving the explanation failed: ${error?.message}`);
  return { id: saved.id, author: "ai", content: answerText, createdAt: saved.created_at };
}
