import { notFound } from "next/navigation";
import { CourseLessonScreen } from "@/components/course/CourseLessonView";
import { requireChild } from "@/server/auth/guards";
import { getCourseLessonView } from "@/server/lessons/courseView";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S34 ($0 course-package importer, PO decision 2026-10-02) — minimal viewer
 * for one imported `course_lessons` row, same naming/structure convention
 * as `/literature/[lessonId]` (S33). A `needs_review` lesson is still shown
 * here (the parent explicitly opened this link); RLS keeps it out of any
 * listing surfaced to the child by default
 * (`course_lessons_select_child` only allows `status = 'active'`).
 */
export default async function CourseLessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  if (!UUID.test(lessonId)) notFound();
  const { ctx } = await requireChild();
  const lesson = await getCourseLessonView(ctx.familyId, lessonId);
  if (!lesson) notFound();

  return <CourseLessonScreen lesson={lesson} />;
}
