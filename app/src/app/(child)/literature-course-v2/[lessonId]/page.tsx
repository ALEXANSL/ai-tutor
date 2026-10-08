import { notFound } from "next/navigation";
import { LiteratureV2LessonScreen } from "@/components/course-v2/LiteratureV2LessonView";
import { requireChild } from "@/server/auth/guards";
import { getLiteratureV2LessonView } from "@/server/lessons/literatureV2View";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S36 (foreign-literature course-package v2 importer) — child-facing
 * viewer for one imported `literature_v2_lessons` row. Same naming/
 * structure convention as `/math-course-v2/[lessonId]` (S35).
 */
export default async function LiteratureV2LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  if (!UUID.test(lessonId)) notFound();
  const { ctx } = await requireChild();
  const lesson = await getLiteratureV2LessonView(ctx.familyId, lessonId);
  if (!lesson) notFound();

  return <LiteratureV2LessonScreen lesson={lesson} />;
}
