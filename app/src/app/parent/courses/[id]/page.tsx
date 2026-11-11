import Link from "next/link";
import { ReadyLessonCatalog } from "@/components/parent/subjects/ReadyLessonCatalog";
import { studioPublicationsForSubject } from "@/server/studio/links";
import { notFound } from "next/navigation";
import { toggleCourseActiveAction } from "@/app/actions/subjects";
import { CourseDetailForm } from "@/components/parent/courses/CourseDetailForm";
import { ActiveToggle } from "@/components/parent/subjects/ActiveToggle";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { getSubjectDetail, listCourseGroupsOverview } from "@/server/subjects/queries";
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
  const access = await requireParentAccess();
  const { familyId } = access;
  const [course, groups] = await Promise.all([getSubjectDetail(familyId, id), listCourseGroupsOverview(familyId)]);
  if (!course || course.kind !== "course") notFound();
  const extensions = await studioPublicationsForSubject(familyId, id).catch(() => []);
  const t = uk.parent.courses;

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

      <div className="mb-5 flex flex-wrap gap-3"><Link href={`/parent/studio/new?subject=${id}`} className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-sm font-bold text-white">Підготувати урок із ШІ</Link><Link href="/parent/materials" className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 text-sm font-bold">Додати готовий ZIP</Link><Link href="/parent/books" className="inline-flex min-h-11 items-center px-3 text-sm font-bold text-p-primary">Книги та джерела</Link></div>
      <Panel title="Готові уроки курсу"><ReadyLessonCatalog extensions={extensions} topics={course.topics} subjectId={id} canOpen={access.via === "tablet"} /></Panel>
    </>
  );
}
