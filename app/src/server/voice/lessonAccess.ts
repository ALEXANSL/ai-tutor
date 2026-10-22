import "server-only";
import { z } from "zod";
import { forFamily } from "@/server/db/family-scope";
import { lessonVoiceTargetSchema, type LessonVoiceTarget } from "./lessonContext";

export interface LessonVoiceAccess { subjectId: string; topicId: string; sessionId?: string }
interface LessonRow { subject_id: string; topic_id: string | null; status: string; package_id?: string }
function unavailable(): never { throw new Error("voice_lesson_unavailable"); }

/** Revalidate authorization without hydrating lesson text, media or signed URLs.
 * Called at every paid stage and heartbeat; never cached across turns. */
export async function assertLessonVoiceAccess(familyId: string, childId: string, raw: LessonVoiceTarget): Promise<LessonVoiceAccess> {
  const target = lessonVoiceTargetSchema.parse(raw);
  const scope = forFamily(familyId);
  let lesson: LessonRow;
  let sessionId: string | undefined;
  if (target.kind === "lesson") {
    const { data, error } = await scope.select("lesson_sessions", "subject_id,topic_id,status,current_step_id,child_profile_id")
      .eq("id", target.sessionId).eq("child_profile_id", childId)
      .maybeSingle<LessonRow & { current_step_id: string | null; child_profile_id: string }>();
    if (error || !data || data.child_profile_id !== childId || data.status !== "active" || data.current_step_id !== target.stepId) unavailable();
    const step = await scope.select("library_steps", "id").eq("id", target.stepId).maybeSingle<{ id: string }>();
    if (step.error || !step.data) unavailable();
    lesson = data;
    sessionId = target.sessionId;
  } else if (target.kind === "course") {
    const item = await scope.select(target.refTable, "lesson_id").eq("id", target.refId).maybeSingle<{ lesson_id: string }>();
    if (item.error || !item.data) unavailable();
    const row = await scope.select(target.refTable.startsWith("course_v2_") ? "course_v2_lessons" : "literature_v2_lessons", "subject_id,topic_id,status")
      .eq("id", item.data.lesson_id).maybeSingle<LessonRow>();
    if (row.error || !row.data || !["active", "needs_review"].includes(row.data.status)) unavailable();
    lesson = row.data;
  } else {
    const row = await scope.select("literature_v3_lessons", "subject_id,topic_id,status,package_id,flow")
      .eq("id", target.lessonId).maybeSingle<LessonRow & { flow: { kind: string; ref_id: string }[] }>();
    if (row.error || !row.data || !["active", "needs_review"].includes(row.data.status) || !Array.isArray(row.data.flow)) unavailable();
    lesson = row.data;
    const flow = row.data.flow;
    if (flow.some(step => step.kind === "quiz" && step.ref_id === target.stepId)) {
      const question = await scope.select("course_v2_questions", "id").eq("literature_v3_lesson_id", target.lessonId)
        .eq("question_key", target.stepId).maybeSingle<{ id: string }>();
      if (question.error || !question.data) unavailable();
    } else {
      // Reading/screen/biography targets are row UUIDs, whereas quiz targets
      // use their public question key. Never send arbitrary keys to UUID filters.
      if (!z.string().uuid().safeParse(target.stepId).success) unavailable();
      const [screen, reading, biography] = await Promise.all([
        scope.select("literature_v3_screens", "screen_key").eq("id", target.stepId).eq("lesson_id", target.lessonId).maybeSingle<{ screen_key: string }>(),
        scope.select("literature_v3_reading_items", "reading_key,work_id").eq("id", target.stepId).maybeSingle<{ reading_key: string; work_id: string }>(),
        scope.select("literature_v3_biographies", "biography_key").eq("id", target.stepId).eq("package_id", lesson.package_id!).maybeSingle<{ biography_key: string }>(),
      ]);
      if (screen.error || reading.error || biography.error) unavailable();
      let present = !!screen.data && flow.some(step => step.kind === "screen" && step.ref_id === screen.data!.screen_key);
      present ||= !!biography.data && flow.some(step => step.kind === "biography" && step.ref_id === biography.data!.biography_key);
      if (reading.data && flow.some(step => step.kind === "reading" && step.ref_id === reading.data!.reading_key)) {
        const work = await scope.select("literature_v3_works", "id").eq("id", reading.data.work_id).eq("package_id", lesson.package_id!).maybeSingle<{ id: string }>();
        if (work.error) unavailable();
        present ||= !!work.data;
      }
      if (!present) unavailable();
    }
  }
  if (!lesson.topic_id) unavailable();
  const topic = await scope.select("topics", "id").eq("id", lesson.topic_id).eq("subject_id", lesson.subject_id).maybeSingle<{ id: string }>();
  if (topic.error || !topic.data) unavailable();
  return { subjectId: lesson.subject_id, topicId: lesson.topic_id, ...(sessionId ? { sessionId } : {}) };
}
