import Link from "next/link";
import { toggleSubjectActiveAction } from "@/app/actions/subjects";
import { ActiveToggle } from "@/components/parent/subjects/ActiveToggle";
import { AddSubjectForm } from "@/components/parent/subjects/AddSubjectForm";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listSubjectsOverview } from "@/server/subjects/queries";
import { PageTitle, Panel } from "../ui";

/**
 * "Предмети" (US-3.1, US-3.2, and — since E-22/ADR-030 — US-22.1): activate a
 * subject, pick its current topic, see the forecast-plan; add a new school
 * subject or toggle one's visibility to the child (VP-52: grey tile, not
 * hidden — unchanged for this kind).
 */
export default async function SubjectsPage() {
  const { familyId } = await requireParentAccess();
  const subjects = await listSubjectsOverview(familyId, "school_subject");
  const t = uk.parent.subjects;

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <p className="-mt-2 mb-4 text-[13px] text-p-muted">{t.listDesc}</p>
      <AddSubjectForm />
      <div className="grid gap-3.5 min-[720px]:grid-cols-2">
        {subjects.map((s) => (
          <Panel key={s.id}>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[15px] font-bold">{s.name}</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white ${s.active ? "bg-p-success" : "bg-p-muted"}`}
                  >
                    {s.active ? t.status.active : t.status.inactive}
                  </span>
                  <ActiveToggle
                    action={toggleSubjectActiveAction}
                    idFieldName="subjectId"
                    id={s.id}
                    active={s.active}
                    labels={t.toggleActive}
                  />
                </div>
              </div>
              {!s.hasTextbook ? (
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-p-warn/15 px-2.5 py-0.5 text-[12px] font-bold text-p-warn">
                  ⚠️ {t.noTextbookBadge}
                </span>
              ) : s.currentTopic ? (
                <div className="text-[13px]">
                  <span className="text-p-muted">{t.currentTopic}: </span>
                  <span className="font-semibold">{s.currentTopic.title}</span>
                </div>
              ) : (
                <span className="text-[13px] text-p-muted">{t.currentTopicNone}</span>
              )}
              <Link href={`/parent/subjects/${s.id}`} className="text-[12px] font-bold text-p-primary">
                {t.open}
              </Link>
            </div>
          </Panel>
        ))}
      </div>
    </>
  );
}
