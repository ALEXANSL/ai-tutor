import Link from "next/link";
import { notFound } from "next/navigation";
import { toggleCourseActiveAction } from "@/app/actions/subjects";
import { CourseDetailForm } from "@/components/parent/courses/CourseDetailForm";
import { ActiveToggle } from "@/components/parent/subjects/ActiveToggle";
import { CurrentTopicPicker } from "@/components/parent/subjects/CurrentTopicPicker";
import { ForecastPlanPanel } from "@/components/parent/subjects/ForecastPlanPanel";
import { LibraryCardsList } from "@/components/parent/subjects/LibraryCardsList";
import { StartLessonButton } from "@/components/parent/subjects/StartLessonButton";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listLibraryCardsForTopic } from "@/server/lessons/library";
import { getSubjectDetail, getSubjectForecastPlan, listCourseGroupsOverview } from "@/server/subjects/queries";
import { PageTitle, Panel } from "../../ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same rationale as parent/subjects/[id] — lesson generation can run past
// the platform's default Server Function timeout.
export const maxDuration = 300;

/**
 * Course detail (US-22.2): rename/re-group, activate/deactivate (VP-52:
 * fully hides from the child, unlike a school subject), and — since a
 * course reuses the exact same pedagogical pipeline as any subject
 * (ADR-030 §2, "subject = data") — the same current-topic picker,
 * forecast-plan and library-of-blocks views as `parent/subjects/[id]`.
 */
export default async function CourseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const { familyId } = await requireParentAccess();
  const [course, groups] = await Promise.all([getSubjectDetail(familyId, id), listCourseGroupsOverview(familyId)]);
  if (!course || course.kind !== "course") notFound();
  const t = uk.parent.courses;
  const plan = course.currentTopicId ? await getSubjectForecastPlan(familyId, id) : null;
  const libraryCards = course.currentTopicId ? await listLibraryCardsForTopic(familyId, course.currentTopicId) : [];

  return (
    <>
      <PageTitle>
        <Link href="/parent/courses" className="mb-1 block text-[13px] font-normal text-p-primary">
          {t.detail.back}
        </Link>
        {course.name}
      </PageTitle>

      <Panel>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white ${course.active ? "bg-p-success" : "bg-p-muted"}`}>
            {course.active ? t.status.active : t.status.inactive}
          </span>
          <ActiveToggle action={toggleCourseActiveAction} idFieldName="subjectId" id={course.id} active={course.active} labels={t.toggleActive} />
        </div>
        <CourseDetailForm subjectId={course.id} name={course.name} groupId={course.groupId} groups={groups} />
      </Panel>

      <Panel title={t.detail.attachHint}>
        <Link href="/parent/books" className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-[14px] font-bold text-white">
          {t.detail.attachCta}
        </Link>
      </Panel>

      {course.topics.length > 0 && (
        <Panel title={uk.parent.subjects.detail.pickerTitle}>
          <CurrentTopicPicker subjectId={course.id} topics={course.topics} currentTopicId={course.currentTopicId} />
        </Panel>
      )}

      {plan && <ForecastPlanPanel plan={plan} />}

      {course.currentTopicId && (
        <Panel title={uk.parent.subjects.detail.lessonTitle}>
          <p className="mb-3 text-[13px] text-p-muted">{uk.parent.subjects.detail.lessonHint}</p>
          <StartLessonButton subjectId={course.id} topicId={course.currentTopicId} />
        </Panel>
      )}

      {course.currentTopicId && (
        <Panel title={uk.parent.subjects.library.title}>
          <LibraryCardsList cards={libraryCards} />
        </Panel>
      )}
    </>
  );
}
