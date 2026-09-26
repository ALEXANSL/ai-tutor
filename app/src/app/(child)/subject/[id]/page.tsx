import Link from "next/link";
import { notFound } from "next/navigation";
import { ChildStartLessonButton } from "@/components/child/ChildStartLessonButton";
import { uk } from "@/i18n/uk";
import { requireChild } from "@/server/auth/guards";
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
  if (!subject || !subject.active) notFound();
  const t = uk.child.today;
  const ts = uk.child.subject;

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
              </div>
              {topic.pageFrom != null && topic.pageTo != null && (
                <p className="mb-3 text-sm text-muted">{ts.pages(topic.pageFrom, topic.pageTo)}</p>
              )}
              <ChildStartLessonButton subjectId={subject.id} topicId={topic.id} />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">{t.emptyPlanBody}</p>
      )}
    </div>
  );
}
