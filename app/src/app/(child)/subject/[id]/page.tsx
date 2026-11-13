import { schoolSubjectFocus } from "@/server/eschool/subjectFocus";
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
import { studioPublicationsForSubject } from "@/server/studio/links";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const maxDuration = 300;

/** Ready imported lessons and optional videos; no legacy generation fallback. */
export default async function ChildSubjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams?: Promise<{ school?: string | string[] }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { ctx, profile } = await requireChild();
  const subject = await getSubjectDetail(ctx.familyId, id);
  // VP-52/US-22.3 КП-3: a direct link to a course must 404 the same way an
  // inactive one does when its group has been turned off — `childVisible`
  // carries that effective-visibility rule (identical to `active` for a
  // school subject, which has no group).
  if (!subject || !subject.childVisible) notFound();
  const publications = await studioPublicationsForSubject(ctx.familyId, subject.id).catch(() => []);
  const extensionTopics = new Set(publications.filter(item => item.baseTopicId).flatMap(item => item.lessons.map(lesson => lesson.topicId)));
  const topics = subject.topics.filter(topic => importedLessonHref(topic) && !extensionTopics.has(topic.id));
  const school = (await searchParams)?.school;
  const focus = typeof school === "string" ? await schoolSubjectFocus(ctx.familyId, profile.id, subject.id, school, topics).catch(() => null) : null;
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
      {focus && <div className="mb-5 rounded-2xl border border-primary bg-surface p-4 text-sm"><p className="font-bold">Зі шкільного щоденника{focus.title ? `: ${focus.title}` : ""}</p><p className="mt-1 text-muted">{focus.topicId ? "Потрібну тему виділено в списку нижче." : "Однозначного збігу з готовими уроками немає. Обери потрібний урок зі списку; тато може зберегти прив’язку у щоденнику."}</p><Link href="/school" className="mt-2 inline-flex min-h-11 items-center font-bold underline">← До щоденника</Link></div>}
      {hasMathCourseV2 && <MathCourseV2Search subjectId={subject.id} textbook={textbook} />}
      {hasLiteratureV2 && <LiteratureV2Search subjectId={subject.id} textbook={literatureTextbook} />}
      {hasLiteratureV3 && <LiteratureV3Search subjectId={subject.id} />}
      {topics.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{ts.topicsSubtitle}</p>
          {topics.map((topic) => (
            <LastLessonHighlight key={topic.id} subjectId={subject.id} topicId={topic.id} schoolContext={!!focus} focusRequest={focus?.topicId === topic.id ? focus.entryId : undefined}>
              <div className="rounded-[22px] border border-line bg-surface p-4.5">
              <div className="mb-1 flex items-center gap-2">
                <p className="font-bold">{topic.title}</p>

              </div>
              {topic.pageFrom != null && topic.pageTo != null && (
                <p className="mb-3 text-sm text-muted">{ts.pages(topic.pageFrom, topic.pageTo)}</p>
              )}
              <div className="flex flex-wrap items-center gap-2.5">
                <Link href={publications.find(item => item.mode === "revision" && item.baseTopicId === topic.id)?.lessons[0] ? `/literature-v3/${publications.find(item => item.mode === "revision" && item.baseTopicId === topic.id)!.lessons[0]!.id}` : importedLessonHref(topic)!} className="inline-flex min-h-12 items-center rounded-2xl bg-primary px-5 text-base font-bold text-white">{ts.openLesson}</Link>
                {topic.hasVideoLesson && <VideoLessonButton topicId={topic.id} title={topic.title} />}
                {publications.filter(item => item.mode !== "revision" && item.baseTopicId === topic.id).flatMap(item => item.lessons).map(lesson => <Link key={lesson.id} href={`/literature-v3/${lesson.id}`} className="inline-flex min-h-12 items-center rounded-2xl border-2 border-secondary bg-surface px-4 text-sm font-bold">Розширений урок: {lesson.title}</Link>)}
              </div>
              </div>
            </LastLessonHighlight>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">Готових уроків поки немає. Тато ще не додав матеріали цього предмета.</p>
      )}
      <SubjectVideoLessons familyId={ctx.familyId} subjectId={subject.id} />
    </div>
  );
}
