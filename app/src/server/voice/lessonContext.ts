import "server-only";
import { z } from "zod";
import { forFamily } from "@/server/db/family-scope";
import { readableTextForStep } from "@/server/lessons/narration";

const uuid = z.string().uuid();
/** IDs are selectors only: no lesson text, topic or subject is trusted from a client. */
export const lessonVoiceTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lesson"), source: z.literal("session"), sessionId: uuid, stepId: uuid }).strict(),
  z.object({
    kind: z.literal("course"),
    refTable: z.enum(["course_v2_screens", "course_v2_exercises", "literature_v2_screens", "literature_v2_tasks"]),
    refId: uuid,
  }).strict(),
]);
export type LessonVoiceTarget = z.infer<typeof lessonVoiceTargetSchema>;

export interface LessonVoiceContext {
  subjectId: string;
  topicId: string;
  context: string;
  sessionId?: string;
}

interface LessonRow { subject_id: string; topic_id: string | null; title: string; status: string }
interface CourseContentRow {
  lesson_id: string;
  display_md?: string;
  narration?: string;
  original_number?: string;
  content_display?: string;
  prompt_display?: string;
  original_label?: string;
  subtasks?: { display?: string }[];
}

function unavailable(): never { throw new Error("voice_lesson_unavailable"); }

/** Read only public lesson content. Private quiz keys and worked solutions never enter this context. */
export async function resolveLessonVoiceTarget(familyId: string, childId: string, rawTarget: LessonVoiceTarget): Promise<LessonVoiceContext> {
  const target = lessonVoiceTargetSchema.parse(rawTarget);
  const scope = forFamily(familyId);
  let subjectId: string;
  let topicId: string;
  let context: string;
  let sessionId: string | undefined;
  if (target.kind === "lesson") {
    const { data: session, error } = await scope.select("lesson_sessions", "child_profile_id,current_step_id,subject_id,topic_id,status")
      .eq("id", target.sessionId)
      .eq("child_profile_id", childId)
      .maybeSingle<{ child_profile_id: string; current_step_id: string | null; subject_id: string; topic_id: string; status: string }>();
    if (error || !session || session.child_profile_id !== childId || session.status !== "active" || session.current_step_id !== target.stepId) unavailable();
    const { data: step, error: stepError } = await scope.select("library_steps", "type,content").eq("id", target.stepId)
      .maybeSingle<{ type: string; content: Record<string, unknown> }>();
    if (stepError || !step) unavailable();
    subjectId = session.subject_id;
    topicId = session.topic_id;
    context = readableTextForStep(step);
    sessionId = target.sessionId;
  } else {
    const columns: Record<typeof target.refTable, string> = {
      course_v2_screens: "lesson_id,display_md,narration",
      course_v2_exercises: "lesson_id,display_md,narration,original_number",
      literature_v2_screens: "lesson_id,content_display",
      literature_v2_tasks: "lesson_id,prompt_display,original_label,subtasks",
    };
    const { data: content, error } = await scope.select(target.refTable, columns[target.refTable])
      .eq("id", target.refId).maybeSingle<CourseContentRow>();
    if (error || !content) unavailable();
    const lessonTable = target.refTable.startsWith("course_v2_") ? "course_v2_lessons" : "literature_v2_lessons";
    const { data: lesson, error: lessonError } = await scope.select(lessonTable, "subject_id,topic_id,title,status")
      .eq("id", content.lesson_id).maybeSingle<LessonRow>();
    if (lessonError || !lesson || !lesson.topic_id || !["active", "needs_review"].includes(lesson.status)) unavailable();
    subjectId = lesson.subject_id;
    topicId = lesson.topic_id;
    context = [lesson.title, content.original_number ? `Вправа №${content.original_number}` : content.original_label,
      content.display_md, content.content_display, content.prompt_display,
      ...(content.subtasks ?? []).map((s) => s.display), content.narration].filter(Boolean).join("\n");
  }
  // A stale or mismatched content/topic association must not attach the child's voice to another subject.
  const { data: topic, error: topicError } = await scope.select("topics", "id").eq("id", topicId).eq("subject_id", subjectId).maybeSingle<{ id: string }>();
  if (topicError || !topic || !context.trim()) unavailable();
  return { subjectId, topicId, context: context.slice(0, 6000), ...(sessionId ? { sessionId } : {}) };
}
