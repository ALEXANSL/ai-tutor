import Link from "next/link";
import { toggleCourseGroupActiveAction } from "@/app/actions/subjects";
import { AddCourseGroupForm } from "@/components/parent/courses/AddCourseGroupForm";
import { RenameCourseGroupForm } from "@/components/parent/courses/RenameCourseGroupForm";
import { ActiveToggle } from "@/components/parent/subjects/ActiveToggle";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listCourseGroupsOverview } from "@/server/subjects/queries";
import { PageTitle, Panel } from "../../ui";

/**
 * "Курси → Групи" (US-22.3, Should): an optional level above courses. A
 * group's own active switch hides ALL its courses from the child at once,
 * independent of each course's own switch (КП-3: effective visibility =
 * group.active AND course.active).
 */
export default async function CourseGroupsPage() {
  const { familyId } = await requireParentAccess();
  const groups = await listCourseGroupsOverview(familyId);
  const t = uk.parent.courseGroups;

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <p className="-mt-2 mb-4 text-[13px] text-p-muted">{t.listDesc}</p>
      <Link href="/parent/courses" className="mb-4 inline-block text-[13px] font-bold text-p-primary">
        ◂ {uk.parent.courses.title}
      </Link>
      <AddCourseGroupForm />
      {groups.length === 0 ? (
        <p className="text-[13px] text-p-muted">{t.empty}</p>
      ) : (
        <div className="grid gap-3.5 min-[720px]:grid-cols-2">
          {groups.map((g) => (
            <Panel key={g.id}>
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white ${g.active ? "bg-p-success" : "bg-p-muted"}`}
                  >
                    {g.active ? t.status.active : t.status.inactive}
                  </span>
                  <ActiveToggle action={toggleCourseGroupActiveAction} idFieldName="groupId" id={g.id} active={g.active} labels={t.toggleActive} />
                </div>
                <span className="text-[13px] text-p-muted">{t.courseCount(g.courseCount)}</span>
                <RenameCourseGroupForm groupId={g.id} name={g.name} />
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
