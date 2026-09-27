import Link from "next/link";
import { notFound } from "next/navigation";
import { BulkWarmupPanel } from "@/components/parent/subjects/BulkWarmupPanel";
import { CurrentTopicPicker } from "@/components/parent/subjects/CurrentTopicPicker";
import { ForecastPlanPanel } from "@/components/parent/subjects/ForecastPlanPanel";
import { LibraryCardsList } from "@/components/parent/subjects/LibraryCardsList";
import { RenameSubjectForm } from "@/components/parent/subjects/RenameSubjectForm";
import { StartLessonButton } from "@/components/parent/subjects/StartLessonButton";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listLibraryCardsForTopic } from "@/server/lessons/library";
import { getTopicWarmupStatuses } from "@/server/lessons/warmup";
import { getSubjectDetail, getSubjectForecastPlan } from "@/server/subjects/queries";
import { PageTitle, Panel } from "../../ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// BUG (urgent, pre-D-65 demo fix): `StartLessonButton` on this page calls
// `startLessonAction`, which can run the full lesson-generation pipeline
// synchronously (planning + generation on Claude, then review) — routinely
// past the platform's default Server Function timeout, so the request was
// cut off with no error ("Почати урок" just hung). Same 300s budget as the
// books indexing routes (`parent/books/*`).
export const maxDuration = 300;

/**
 * Subject detail (US-3.1, US-3.2): activate the subject by picking its
 * current topic, or — if it has no ready textbook yet — a plain explanation
 * instead of letting the parent try and fail silently (US-3.1 KP-2).
 */
export default async function SubjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { familyId } = await requireParentAccess();
  const subject = await getSubjectDetail(familyId, id);
  if (!subject) notFound();
  const t = uk.parent.subjects;
  const plan = subject.currentTopicId ? await getSubjectForecastPlan(familyId, id) : null;
  const libraryCards = subject.currentTopicId ? await listLibraryCardsForTopic(familyId, subject.currentTopicId) : [];
  // US-22.4 (D-108, S33): every topic's current warm-up status, for the
  // bulk-select panel's badges — computed even before the parent picks
  // anything, so a topic already warmed up by an automatic trigger shows
  // "Готово" from the very first render (КП-5).
  const bulkWarmupStatuses = subject.topics.length > 0 ? await getTopicWarmupStatuses(familyId, subject.topics.map((tp) => tp.id)) : {};

  return (
    <>
      <PageTitle>
        <Link href="/parent/subjects" className="mb-1 block text-[13px] font-normal text-p-primary">
          {t.detail.back}
        </Link>
        {subject.name}
      </PageTitle>

      <Panel>
        <RenameSubjectForm subjectId={subject.id} name={subject.name} />
      </Panel>

      {!subject.hasTextbook ? (
        <Panel title={t.noTextbook.title}>
          <p className="mb-3 text-[14px] text-p-text">{t.noTextbook.body}</p>
          <Link href="/parent/books" className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white">
            {t.noTextbook.cta}
          </Link>
        </Panel>
      ) : (
        <Panel title={t.detail.pickerTitle}>
          {subject.topics.length === 0 ? (
            <p className="text-[13px] text-p-muted">{t.noTopicsYet}</p>
          ) : (
            <CurrentTopicPicker subjectId={subject.id} topics={subject.topics} currentTopicId={subject.currentTopicId} />
          )}
        </Panel>
      )}

      {subject.hasTextbook && subject.topics.length > 0 && (
        <Panel title={t.bulkWarmup.title}>
          <BulkWarmupPanel subjectId={subject.id} topics={subject.topics.map((tp) => ({ id: tp.id, title: tp.title }))} initialStatuses={bulkWarmupStatuses} />
        </Panel>
      )}

      {plan && <ForecastPlanPanel plan={plan} />}

      {subject.currentTopicId && (
        <Panel title={t.detail.lessonTitle}>
          <p className="mb-3 text-[13px] text-p-muted">{t.detail.lessonHint}</p>
          <StartLessonButton subjectId={subject.id} topicId={subject.currentTopicId} />
        </Panel>
      )}

      {subject.currentTopicId && (
        <Panel title={t.library.title}>
          <LibraryCardsList cards={libraryCards} />
        </Panel>
      )}
    </>
  );
}
