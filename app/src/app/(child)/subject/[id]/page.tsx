import Link from "next/link";
import { notFound } from "next/navigation";
import { ChildStartLessonButton } from "@/components/child/ChildStartLessonButton";
import { PrepareTopicButton } from "@/components/child/PrepareTopicButton";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
import { getTopicWarmupStatuses } from "@/server/lessons/warmup";
import { getSubjectDetail } from "@/server/subjects/queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// BUG (urgent, pre-D-65 demo fix): `ChildStartLessonButton` here calls
// `startLessonAction`, which can run the full lesson-generation pipeline
// synchronously (planning + generation on Claude, then review) — routinely
// past the platform's default Server Function timeout, so "Почати" just
// hung with no error. A "use server" file may only export async functions
// (this Next.js version rejects `maxDuration` there at build time), so the
// fix lives here instead, on every page that can trigger the action. Same
// 300s budget as the books indexing routes (`parent/books/*`).
export const maxDuration = 300;

/**
 * The child's own minimal subject screen (S4 — replaces the S3 restriction
 * that made `/parent/subjects/[id]` the only "Почати урок" entry point).
 * Deliberately small: the real "Сьогодні" plan-of-day with its own recommended
 * blocks is US-9.1 (S8) — this only unblocks "the child can start today's
 * current topic on her own" for an already-activated subject.
 */
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
  const t = uk.child.today;
  const ts = uk.child.subject;
  // US-19.5 КП-1/КП-2: reuse the exact same "does this topic already have an
  // active block, or is one being prepared?" fact the parent's bulk-warmup
  // panel shows (US-22.4 КП-5) — now three child-facing states: ready /
  // in-progress (queued or generating, incl. from КП-2's own "Підготувати")
  // / needs preparing.
  const warmupStatuses = subject.topics.length > 0 ? await getTopicWarmupStatuses(ctx.familyId, subject.topics.map((tp) => tp.id)) : {};

  return (
    <div className="px-6 pt-5 pb-10">
      <Link href="/today" className="mb-3 inline-block text-sm font-bold text-muted underline">
        {uk.child.lesson.backToToday}
      </Link>
      <h1 className="mb-4 text-2xl font-extrabold">{subject.name}</h1>
      {subject.topics.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">{ts.topicsSubtitle}</p>
          {subject.topics.map((topic) => (
            <div key={topic.id} className="rounded-[22px] border border-line bg-surface p-4.5">
              <div className="mb-1 flex items-center gap-2">
                <p className="font-bold">{topic.title}</p>
                {topic.id === subject.currentTopicId && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">{ts.priorityBadge}</span>
                )}
                {/* S33/D-123: this badge reports the OLD pipeline's
                    `library_items` warm-up state, which is meaningless for a
                    topic already served by its own `literature_lessons` row
                    — omit it there rather than show a misleading "Потрібна
                    підготовка"/"Готуємо…" next to an already-ready lesson. */}
                {!topic.literatureLessonId && !topic.courseLessonId && (
                  <span
                    className={
                      warmupStatuses[topic.id] === "ready"
                        ? "rounded-full bg-secondary/10 px-2 py-0.5 text-xs font-bold text-secondary"
                        : warmupStatuses[topic.id] === "queued" || warmupStatuses[topic.id] === "generating"
                          ? "rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary"
                          : "rounded-full bg-surface-alt px-2 py-0.5 text-xs font-bold text-muted"
                    }
                  >
                    {warmupStatuses[topic.id] === "ready"
                      ? ts.topicStatus.ready
                      : warmupStatuses[topic.id] === "queued" || warmupStatuses[topic.id] === "generating"
                        ? ts.topicStatus.inProgress
                        : ts.topicStatus.needsPrep}
                  </span>
                )}
              </div>
              {topic.pageFrom != null && topic.pageTo != null && (
                <p className="mb-3 text-sm text-muted">{ts.pages(topic.pageFrom, topic.pageTo)}</p>
              )}
              <div className="flex flex-wrap items-center gap-2.5">
                {topic.literatureLessonId ? (
                  // S33/D-123: this topic already has an active
                  // extraction-pipeline lesson — link straight to its own
                  // viewer. The old pipeline is never offered for it: for a
                  // paragraph-structured subject it has no way to ever reach
                  // `active` (see `pipeline.ts`'s `MAX_REVISIONS` comment),
                  // so showing it here would just be a dead end.
                  <Link
                    href={`/literature/${topic.literatureLessonId}`}
                    className="inline-flex min-h-12 items-center rounded-2xl bg-primary px-5 text-base font-bold text-white"
                  >
                    {ts.openLesson}
                  </Link>
                ) : topic.courseLessonId ? (
                  // S34/D-123: same idea, parallel $0 image-anchored
                  // course-package import (courseImport.ts) — a topic
                  // resolves to whichever system has active content for it.
                  <Link
                    href={`/course-lesson/${topic.courseLessonId}`}
                    className="inline-flex min-h-12 items-center rounded-2xl bg-primary px-5 text-base font-bold text-white"
                  >
                    {ts.openLesson}
                  </Link>
                ) : (
                  <>
                    <ChildStartLessonButton subjectId={subject.id} topicId={topic.id} />
                    {warmupStatuses[topic.id] !== "ready" && warmupStatuses[topic.id] !== "queued" && warmupStatuses[topic.id] !== "generating" && (
                      <PrepareTopicButton subjectId={subject.id} topicId={topic.id} />
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">{t.emptyPlanBody}</p>
      )}
    </div>
  );
}
