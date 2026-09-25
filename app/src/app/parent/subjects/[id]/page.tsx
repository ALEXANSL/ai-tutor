import Link from "next/link";
import { notFound } from "next/navigation";
import { CurrentTopicPicker } from "@/components/parent/subjects/CurrentTopicPicker";
import { ForecastPlanPanel } from "@/components/parent/subjects/ForecastPlanPanel";
import { StartLessonButton } from "@/components/parent/subjects/StartLessonButton";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { getSubjectDetail, getSubjectForecastPlan } from "@/server/subjects/queries";
import { PageTitle, Panel } from "../../ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  return (
    <>
      <PageTitle>
        <Link href="/parent/subjects" className="mb-1 block text-[13px] font-normal text-p-primary">
          {t.detail.back}
        </Link>
        {subject.name}
      </PageTitle>

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

      {plan && <ForecastPlanPanel plan={plan} />}

      {subject.currentTopicId && (
        <Panel title={t.detail.lessonTitle}>
          <p className="mb-3 text-[13px] text-p-muted">{t.detail.lessonHint}</p>
          <StartLessonButton subjectId={subject.id} topicId={subject.currentTopicId} />
        </Panel>
      )}
    </>
  );
}
