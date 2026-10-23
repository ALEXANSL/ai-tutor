import { TopicVideoSupplement } from "@/components/child/SubjectVideoLessons";
import { notFound } from "next/navigation";
import { LiteratureV3LessonScreen } from "@/components/course-v2/LiteratureV3LessonView";
import { requireChild } from "@/server/auth/guards";
import { getLiteratureV3BookIndex, getLiteratureV3LessonView, getLiteratureV3ReadingPosition, listLiteratureV3Lessons } from "@/server/lessons/literatureV3View";
import { hasVideoLessonForTopic } from "@/server/lessons/videoLessons";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * S45 (E-31/US-31.1…31.2, ADR-044) — child-facing viewer for one imported
 * `literature_v3_lessons` row. Same naming/structure convention as
 * `/math-course-v2/[lessonId]` (S35) and `/literature-course-v2/[lessonId]`
 * (S36).
 */
export default async function LiteratureV3LessonPage({ params }: { params: Promise<{ lessonId: string }> }) {
  const { lessonId } = await params;
  if (!UUID.test(lessonId)) notFound();
  const { ctx, profile } = await requireChild();
  const lesson = await getLiteratureV3LessonView(ctx.familyId, lessonId);
  if (!lesson) notFound();
  const [packageLessons, bookIndex, savedPosition, hasVideoLesson] = await Promise.all([
    listLiteratureV3Lessons(ctx.familyId, lesson.packageId),
    getLiteratureV3BookIndex(ctx.familyId, lesson.packageId),
    getLiteratureV3ReadingPosition(ctx.familyId, profile.id, lesson.id),
    hasVideoLessonForTopic(ctx.familyId, lesson.topicId),
  ]);

  return <>{!hasVideoLesson && <TopicVideoSupplement familyId={ctx.familyId} subjectId={lesson.subjectId} topicId={lesson.topicId} title={lesson.title} />}<LiteratureV3LessonScreen lesson={lesson} packageLessons={packageLessons} bookIndex={bookIndex} savedPosition={savedPosition} hasVideoLesson={hasVideoLesson} /></>;
}
