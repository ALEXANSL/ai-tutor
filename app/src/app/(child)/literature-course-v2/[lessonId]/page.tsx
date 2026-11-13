import { notFound, redirect } from "next/navigation";
import { studioReplacementForPath } from "@/server/studio/links";
import { LiteratureV2LessonScreen } from "@/components/course-v2/LiteratureV2LessonView";
import { requireChild } from "@/server/auth/guards";
import { getLiteratureV2LessonView, listLiteratureV2Lessons } from "@/server/lessons/literatureV2View";
import { resolveLessonVideoTopicId } from "@/server/lessons/lessonVideo";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S36 (foreign-literature course-package v2 importer) — child-facing
 * viewer for one imported `literature_v2_lessons` row. Same naming/
 * structure convention as `/math-course-v2/[lessonId]` (S35).
 */
export default async function LiteratureV2LessonPage({ params, searchParams }: { params: Promise<{ lessonId: string }>; searchParams?: Promise<{ original?: string }> }) {
  const { lessonId } = await params;
  if (!UUID.test(lessonId)) notFound();
  const { ctx } = await requireChild();
  const lesson = await getLiteratureV2LessonView(ctx.familyId, lessonId);
  if (!lesson) notFound();
  if ((await searchParams)?.original !== "1") { const replacement = await studioReplacementForPath(ctx.familyId, `/literature-course-v2/${lessonId}`).catch(() => null); if (replacement) redirect(replacement); }
  const [packageLessons, videoLessonTopicId] = await Promise.all([
    listLiteratureV2Lessons(ctx.familyId, lesson.packageId),
    resolveLessonVideoTopicId(ctx.familyId, lesson.subjectId, lesson.topicId, lesson.title),
  ]);

  return <LiteratureV2LessonScreen lesson={lesson} packageLessons={packageLessons} videoLessonTopicId={videoLessonTopicId} />;
}
