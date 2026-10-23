import "server-only";
import { z } from "zod";
import { forFamily } from "@/server/db/family-scope";
import { readableTextForStep } from "@/server/lessons/narration";
import { getLiteratureV3LessonView } from "@/server/lessons/literatureV3View";

const uuid = z.string().uuid();
/** IDs are selectors only: no lesson text, topic or subject is trusted from a client. */
export const lessonVoiceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chapter"), lessonId: uuid, stepId: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("lesson"), source: z.literal("session"), sessionId: uuid, stepId: uuid }).strict(),
  z.object({
    kind: z.literal("course"),
    refTable: z.enum(["course_v2_screens", "course_v2_exercises", "literature_v2_screens", "literature_v2_tasks"]),
    refId: uuid,
  }).strict(),
  // US-8.5/S46 "ШІ-друг": free-topic chat, no lesson/subject/topic at all —
  // one of several named chats per child, so `chatId` says which.
  z.object({ kind: z.literal("friend"), chatId: uuid }).strict(),
]);
export type LessonVoiceTarget = z.infer<typeof lessonVoiceTargetSchema>;

/** A server-derived selector. Never accept this object from the browser. */
export interface LessonVoiceLessonRef {
  kind: "math" | "literature" | "chapter" | "session";
  /** For session targets this is the authenticated lesson_sessions ID. */
  lessonId: string;
  packageId?: string;
  currentItemId: string;
}

export interface LessonVoiceContext {
  /** Absent only for `{ kind: "friend" }` — no subject/topic exists to attach to. */
  subjectId?: string;
  topicId?: string;
  context: string;
  sessionId?: string;
  lessonRef?: LessonVoiceLessonRef;
}

interface LessonRow { subject_id: string; topic_id: string | null; title: string; status: string; package_id?: string }
interface CourseContentRow {
  lesson_id: string;
  id?: string;
  title?: string;
  display_md?: string;
  narration?: string;
  original_number?: string;
  printed_page?: number | null;
  content_display?: string;
  prompt_display?: string;
  original_label?: string;
  subtasks?: { display?: string }[];
}

function unavailable(): never { throw new Error("voice_lesson_unavailable"); }

const MAX_MANIFEST_ITEMS = 128;
const MAX_FOCUSED_TEXT = 6000;
interface ManifestItem { id: string; kind: string; label?: string; text: string }

function clipped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [фрагмент скорочено]`;
}

/** Keep the inventory independent of the focused text's budget. A long current
 * reading must never hide the existence of the other tasks in the lesson. */
function contextWithManifest(title: string, focusedText: string, items: ManifestItem[], incomplete = false): string {
  const inventory = items.slice(0, MAX_MANIFEST_ITEMS).map((item, index) =>
    `${index + 1}. ${item.kind}; id=${item.id}; ${clipped(item.label ?? "", 60)}; ${clipped(item.text.replace(/\s+/g, " ").trim(), 100)}`,
  );
  return [
    `Урок: ${clipped(title, 300)}`,
    "СКЛАД УРОКУ (поточний екран — лише частина уроку):",
    ...inventory,
    incomplete || items.length > MAX_MANIFEST_ITEMS
      ? "Перелік неповний або недоступний. Відсутність у ньому не доводить, що задачі немає; потрібен окремий пошук."
      : "Наведено всі доступні кроки й завдання цього уроку.",
    "ПОТОЧНИЙ ЕКРАН (місце повернення після запитання або відступу):",
    clipped(focusedText, MAX_FOCUSED_TEXT),
    "Зображення цьому діалогу не передано. Не вигадуй деталей ілюстрацій. Номери кроків та внутрішні id не є друкованими номерами задач.",
  ].join("\n");
}

async function courseManifest(scope: ReturnType<typeof forFamily>, lessonId: string, math: boolean): Promise<{ items: ManifestItem[]; incomplete: boolean }> {
  const [{ data: screens, error: screenError }, { data: tasks, error: taskError }, { data: quiz, error: quizError }] = await Promise.all([
    scope.select(math ? "course_v2_screens" : "literature_v2_screens", math ? "id,title,display_md" : "id,content_display")
      .eq("lesson_id", lessonId).order("order_no").limit(MAX_MANIFEST_ITEMS + 1).returns<CourseContentRow[]>(),
    scope.select(math ? "course_v2_exercises" : "literature_v2_tasks", math ? "id,original_number,display_md" : "id,original_label,prompt_display,subtasks")
      .eq("lesson_id", lessonId).limit(MAX_MANIFEST_ITEMS + 1).returns<CourseContentRow[]>(),
    math ? scope.select("course_v2_quizzes", "id,title").eq("lesson_id", lessonId).maybeSingle<{ id: string; title: string }>()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const items: ManifestItem[] = [
    ...(tasks ?? []).map(row => ({ id: row.id ?? "", kind: "завдання", label: row.original_number ? `Вправа №${row.original_number}` : row.original_label, text: row.display_md ?? row.prompt_display ?? "" })),
    ...(screens ?? []).map(row => ({ id: row.id ?? "", kind: "пояснення", label: row.title, text: row.display_md ?? row.content_display ?? "" })),
  ];
  let incomplete = !!screenError || !!taskError || !!quizError;
  if (quiz) {
    const { data: quizItems, error: quizItemsError } = await scope
      .select("course_v2_quiz_items", "order_no,course_v2_questions(id,display_md,options)")
      .eq("quiz_id", quiz.id).order("order_no").limit(MAX_MANIFEST_ITEMS + 1)
      .returns<{ course_v2_questions: { id: string; display_md: string; options: { display_md: string }[] } | null }[]>();
    incomplete ||= !!quizItemsError;
    for (const row of quizItems ?? []) {
      const question = row.course_v2_questions;
      if (!question) { incomplete = true; continue; }
      items.push({ id: question.id, kind: "квіз", label: quiz.title,
        text: [question.display_md, ...question.options.map(option => option.display_md)].join(" ") });
    }
  }
  return { items, incomplete: incomplete || items.length > MAX_MANIFEST_ITEMS };
}

/** Read only public lesson content. Private quiz keys and worked solutions never enter this context. */
export async function resolveLessonVoiceTarget(familyId: string, childId: string, rawTarget: LessonVoiceTarget): Promise<LessonVoiceContext> {
  const target = lessonVoiceTargetSchema.parse(rawTarget);
  if (target.kind === "friend") {
    // No lesson content to narrate — `askFriendChat` builds its own context
    // from the chat's own history. This is just enough for `callAudio`/the
    // budget/lease plumbing shared with every other target kind. Still
    // verifies ownership — a forged chatId must never attach a reply to
    // another child's (or a hidden/"deleted") chat.
    const own = await forFamily(familyId).select("chats", "id").eq("id", target.chatId).eq("child_profile_id", childId).eq("kind", "friend").is("hidden_from_child_at", null).maybeSingle<{ id: string }>();
    if (!own.data) unavailable();
    return { context: "Вільна розмова з дитиною поза уроком (ШІ-друг)." };
  }
  const scope = forFamily(familyId);
  let subjectId: string;
  let topicId: string;
  let context: string;
  let sessionId: string | undefined;
  let lessonRef: LessonVoiceLessonRef;
  if (target.kind === "chapter") {
    const lesson = await getLiteratureV3LessonView(familyId, target.lessonId, { includeIllustrations: false });
    if (!lesson || !lesson.topicId || !["active", "needs_review"].includes(lesson.status)) unavailable();
    const step = lesson.flow.find(step => step.id === target.stepId);
    if (!step) unavailable();
    subjectId = lesson.subjectId;
    topicId = lesson.topicId;
    const publicStepText = (item: typeof step) => item.kind === "quiz"
      ? [item.question.displayMd, ...item.question.options.map(option => option.displayMd)].join("\n")
      : item.displayText;
    const items: ManifestItem[] = lesson.flow.map(item => ({
      id: item.id,
      kind: item.kind,
      label: item.kind === "biography" ? item.authorName : item.kind === "quiz" ? "Питання" : item.title,
      text: publicStepText(item),
    }));
    context = contextWithManifest(lesson.title, [step.kind === "reading" && step.bookPage ? `Друкована сторінка: ${step.bookPage}` : "",
      publicStepText(step)].filter(Boolean).join("\n"), items);
    lessonRef = { kind: "chapter", lessonId: target.lessonId, packageId: lesson.packageId, currentItemId: target.stepId };
  } else if (target.kind === "lesson") {
    const { data: session, error } = await scope.select("lesson_sessions", "child_profile_id,current_step_id,subject_id,topic_id,status")
      .eq("id", target.sessionId)
      .eq("child_profile_id", childId)
      .maybeSingle<{ child_profile_id: string; current_step_id: string | null; subject_id: string; topic_id: string; status: string }>();
    if (error || !session || session.child_profile_id !== childId || session.status !== "active" || session.current_step_id !== target.stepId) unavailable();
    const { data: step, error: stepError } = await scope.select("library_steps", "id,item_id,type,content").eq("id", target.stepId)
      .maybeSingle<{ id: string; item_id: string; type: string; content: Record<string, unknown> }>();
    if (stepError || !step) unavailable();
    subjectId = session.subject_id;
    topicId = session.topic_id;
    const siblings = step.item_id
      ? await scope.select("library_steps", "id,type,content").eq("item_id", step.item_id)
        .order("sort_order").limit(MAX_MANIFEST_ITEMS + 1).returns<{ id: string; type: string; content: Record<string, unknown> }[]>()
      : { data: null, error: true };
    context = contextWithManifest("Поточний навчальний блок", readableTextForStep(step), (siblings.data ?? []).map(item => ({
      id: item.id, kind: item.type, text: readableTextForStep(item),
    })), !!siblings.error);
    sessionId = target.sessionId;
    lessonRef = { kind: "session", lessonId: target.sessionId, currentItemId: target.stepId };
  } else {
    const columns: Record<typeof target.refTable, string> = {
      course_v2_screens: "lesson_id,display_md,narration",
      course_v2_exercises: "lesson_id,display_md,narration,original_number,printed_page",
      literature_v2_screens: "lesson_id,content_display",
      literature_v2_tasks: "lesson_id,prompt_display,original_label,subtasks,printed_page",
    };
    const { data: content, error } = await scope.select(target.refTable, columns[target.refTable])
      .eq("id", target.refId).maybeSingle<CourseContentRow>();
    if (error || !content) unavailable();
    const lessonTable = target.refTable.startsWith("course_v2_") ? "course_v2_lessons" : "literature_v2_lessons";
    const { data: lesson, error: lessonError } = await scope.select(lessonTable, "subject_id,topic_id,title,status,package_id")
      .eq("id", content.lesson_id).maybeSingle<LessonRow>();
    if (lessonError || !lesson || !lesson.topic_id || !["active", "needs_review"].includes(lesson.status)) unavailable();
    subjectId = lesson.subject_id;
    topicId = lesson.topic_id;
    const manifest = await courseManifest(scope, content.lesson_id, target.refTable.startsWith("course_v2_"));
    context = contextWithManifest(lesson.title, [content.printed_page ? `Друкована сторінка: ${content.printed_page}` : "", content.original_number ? `Вправа №${content.original_number}` : content.original_label,
      content.display_md, content.content_display, content.prompt_display,
      ...(content.subtasks ?? []).map((s) => s.display), content.narration].filter(Boolean).join("\n"), manifest.items, manifest.incomplete);
    lessonRef = { kind: target.refTable.startsWith("course_v2_") ? "math" : "literature", lessonId: content.lesson_id,
      ...(lesson.package_id ? { packageId: lesson.package_id } : {}), currentItemId: target.refId };
  }
  // A stale or mismatched content/topic association must not attach the child's voice to another subject.
  const { data: topic, error: topicError } = await scope.select("topics", "id").eq("id", topicId).eq("subject_id", subjectId).maybeSingle<{ id: string }>();
  if (topicError || !topic || !context.trim()) unavailable();
  return { subjectId, topicId, context, lessonRef, ...(sessionId ? { sessionId } : {}) };
}
