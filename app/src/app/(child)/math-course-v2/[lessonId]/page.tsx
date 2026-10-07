import { notFound } from "next/navigation";
import { MathCourseV2LessonScreen } from "@/components/course-v2/MathCourseV2LessonView";
import { requireChild } from "@/server/auth/guards";
import { getMathCourseV2LessonView } from "@/server/lessons/mathCourseV2View";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S35 ($0 math course-package v2 importer, PO instruction 2026-10-07) —
 * child-facing viewer for one imported `course_v2_lessons` row. Same
 * naming/structure convention as `/course-lesson/[lessonId]` (S34) and
 * `/literature/[lessonId]` (S33).
 */
export default async function MathCourseV2LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  if (!UUID.test(lessonId)) notFound();
  const { ctx } = await requireChild();
  const lesson = await getMathCourseV2LessonView(ctx.familyId, lessonId);
  if (!lesson) notFound();

  return <MathCourseV2LessonScreen lesson={lesson} />;
}
