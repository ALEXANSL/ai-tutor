import { importedLessonHref } from "@/lib/imported-lesson-link";
import { SubjectVideoLessons } from "@/components/child/SubjectVideoLessons";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LastLessonHighlight } from "@/components/child/LastLessonHighlight";
import { VideoLessonButton } from "@/components/child/VideoLessonButton";
import { LiteratureV2Search } from "@/components/course-v2/LiteratureV2Search";
import { LiteratureV3Search } from "@/components/course-v2/LiteratureV3Search";
import { MathCourseV2Search } from "@/components/course-v2/MathCourseV2Search";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
import { getLiteratureV2TextbookForSubject } from "@/server/lessons/literatureV2Search";
import { getMathCourseV2TextbookForSubject } from "@/server/lessons/mathCourseV2Search";
import { getSubjectDetail } from "@/server/subjects/queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const maxDuration = 300;

/** Ready imported lessons and optional videos; no legacy generation fallback. */
export default async function ChildSubjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { ctx } = await requireChild();
  const subject = await getSubjectDetail(ctx.familyId, id);
  // VP-52/US-22.3 КП-3: a direct link to a course must 404 the same way an
  // inactive one does when its group has been turned off — `childVisible`
  // carries that effective-visibility rule (identical to `active` for a
  // school subject, which has no group).
  if (!subject || !subject.childVisible) notFound();
  const topics = subject.topics.filter(topic => importedLessonHref(topic));
  const ts = uk.child.subject;
  const hasMathCourseV2 = topics.some((t) => t.mathCourseV2LessonId);
  const hasLiteratureV2 = topics.some((t) => t.literatureV2LessonId);
  const hasLiteratureV3 = topics.some((t) => t.literatureV3LessonId);
  const [textbook, literatureTextbook] = await Promise.all([
    hasMathCourseV2 ? getMathCourseV2TextbookForSubject(ctx.familyId, subject.id) : Promise.resolve(null),
    hasLiteratureV2 ? getLiteratureV2TextbookForSubject(ctx.familyId, subject.id) : Promise.resolve(null),
  ]);

  return (
    <div className="px-6 pt-5 pb-10">
      <Link href="/today" className="mb-3 inline-block text-sm font-bold text-muted underline">
        {uk.child.lesson.backToToday}
      </Link>
      <h1 className="mb-4 text-2xl font-extrabold">{subject.name}</h1>
      {hasMathCourseV2 && <MathCourseV2Search subjectId={subject.id} textbook={textbook} />}
      {hasLiteratureV2 && <LiteratureV2Search subjectId={subject.id} textbook={literatureTextbook} />}
      {hasLiteratureV3 && <LiteratureV3Search subjectId={subject.id} />}
      <SubjectVideoLessons familyId={ctx.familyId} subjectId={subject.id} />
      {topics.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{ts.topicsSubtitle}</p>
          {topics.map((topic) => (
            <LastLessonHighlight key={topic.id} subjectId={subject.id} topicId={topic.id}>
              <div className="rounded-[22px] border border-line bg-surface p-4.5">
              <div className="mb-1 flex items-center gap-2">
                <p className="font-bold">{topic.title}</p>

              </div>
              {topic.pageFrom != null && topic.pageTo != null && (
                <p className="mb-3 text-sm text-muted">{ts.pages(topic.pageFrom, topic.pageTo)}</p>
              )}
              <div className="flex flex-wrap items-center gap-2.5">
                <Link href={importedLessonHref(topic)!} className="inline-flex min-h-12 items-center rounded-2xl bg-primary px-5 text-base font-bold text-white">{ts.openLesson}</Link>
                {topic.hasVideoLesson && <VideoLessonButton topicId={topic.id} title={topic.title} />}
              </div>
              </div>
            </LastLessonHighlight>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">Готових уроків поки немає. Тато ще не додав матеріали цього предмета.</p>
      )}
    </div>
  );
}
