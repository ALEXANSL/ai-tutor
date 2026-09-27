import Link from "next/link";
import { toggleCourseActiveAction } from "@/app/actions/subjects";
import { ActiveToggle } from "@/components/parent/subjects/ActiveToggle";
import { AddCourseForm } from "@/components/parent/courses/AddCourseForm";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listCourseGroupsOverview, listSubjectsOverview } from "@/server/subjects/queries";
import { PageTitle, Panel } from "../ui";

/**
 * "Курси" (US-22.2, ADR-030): a screen deliberately SEPARATE from
 * "Предмети" — a course's `active=false` fully hides it from the child
 * (VP-52), unlike a school subject's grey tile.
 */
export default async function CoursesPage() {
  const { familyId } = await requireParentAccess();
  const [courses, groups] = await Promise.all([listSubjectsOverview(familyId, "course"), listCourseGroupsOverview(familyId)]);
  const t = uk.parent.courses;

  return (
    <>
      <PageTitle action={<Link href="/parent/courses/groups" className="text-[13px] font-bold text-p-primary">{t.groupsLink}</Link>}>
        {t.title}
      </PageTitle>
      <p className="-mt-2 mb-4 text-[13px] text-p-muted">{t.listDesc}</p>
      <AddCourseForm groups={groups} />
      {courses.length === 0 ? (
        <p className="text-[13px] text-p-muted">{t.empty}</p>
      ) : (
        <div className="grid gap-3.5 min-[720px]:grid-cols-2">
          {courses.map((c) => (
            <Panel key={c.id}>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[15px] font-bold">{c.name}</span>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white ${c.active ? "bg-p-success" : "bg-p-muted"}`}
                    >
                      {c.active ? t.status.active : t.status.inactive}
                    </span>
                    <ActiveToggle
                      action={toggleCourseActiveAction}
                      idFieldName="subjectId"
                      id={c.id}
                      active={c.active}
                      labels={t.toggleActive}
                    />
                  </div>
                </div>
                <div className="text-[13px] text-p-muted">
                  {t.groupLabel}: {c.groupName ?? t.noGroup}
                </div>
                <Link href={`/parent/courses/${c.id}`} className="text-[12px] font-bold text-p-primary">
                  {t.open}
                </Link>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
