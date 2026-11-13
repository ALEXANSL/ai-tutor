import { notFound, redirect } from "next/navigation";
import { studioReplacementForPath, studioRevisionNavigation } from "@/server/studio/links";
import { LiteratureV3LessonScreen } from "@/components/course-v2/LiteratureV3LessonView";
import { requireChild } from "@/server/auth/guards";
import { getLiteratureV3BookIndex, getLiteratureV3LessonView, getLiteratureV3ReadingPosition, listLiteratureV3Lessons } from "@/server/lessons/literatureV3View";
import { resolveLessonVideoTopicId } from "@/server/lessons/lessonVideo";
import { studioSubjectVisible } from "@/server/studio/visibility";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S45 (E-31/US-31.1…31.2, ADR-044) — child-facing viewer for one imported
 * `literature_v3_lessons` row. Same naming/structure convention as
 * `/math-course-v2/[lessonId]` (S35) and `/literature-course-v2/[lessonId]`
 * (S36).
 */
export default async function LiteratureV3LessonPage({ params, searchParams }: { params: Promise<{ lessonId: string }>; searchParams?: Promise<{ original?: string }> }) {
  const { lessonId } = await params;
  if (!UUID.test(lessonId)) notFound();
  const { ctx, profile } = await requireChild();
  const lesson = await getLiteratureV3LessonView(ctx.familyId, lessonId);
  if (!lesson) notFound();
  if ((await searchParams)?.original !== "1") { const replacement = await studioReplacementForPath(ctx.familyId, `/literature-v3/${lessonId}`).catch(() => null); if (replacement) redirect(replacement); }
  if (lesson.packageKey?.startsWith("studio.")) {
    if (lesson.status !== "active") notFound();
    if (!await studioSubjectVisible(ctx.familyId, lesson.subjectId)) notFound();
  }
  const [packageLessons, bookIndex, savedPosition, videoLessonTopicId] = await Promise.all([
    listLiteratureV3Lessons(ctx.familyId, lesson.packageId),
    getLiteratureV3BookIndex(ctx.familyId, lesson.packageId),
    getLiteratureV3ReadingPosition(ctx.familyId, profile.id, lesson.id),
    resolveLessonVideoTopicId(ctx.familyId, lesson.subjectId, lesson.topicId, lesson.title),
  ]);

  const revisionNav = lesson.packageKey?.startsWith("studio.") ? await studioRevisionNavigation(ctx.familyId, lesson.subjectId, lesson.id).catch(() => null) : null;
  const inheritedVideo = !videoLessonTopicId && revisionNav ? await resolveLessonVideoTopicId(ctx.familyId, lesson.subjectId, revisionNav.topicId, lesson.title) : null;
  return <LiteratureV3LessonScreen lesson={lesson} packageLessons={revisionNav?.lessons ?? packageLessons} navigationTopicId={revisionNav?.topicId} bookIndex={bookIndex} savedPosition={savedPosition} videoLessonTopicId={videoLessonTopicId ?? inheritedVideo} />;
}

export const maxDuration = 180;
