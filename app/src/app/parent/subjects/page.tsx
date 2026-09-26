import Link from "next/link";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listSubjectsOverview } from "@/server/subjects/queries";
import { PageTitle, Panel } from "../ui";

/** "Предмети" (US-3.1, US-3.2): activate a subject, pick its current topic, see the forecast-plan. */
export default async function SubjectsPage() {
  const { familyId } = await requireParentAccess();
  const subjects = await listSubjectsOverview(familyId);
  const t = uk.parent.subjects;

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <p className="-mt-2 mb-4 text-[13px] text-p-muted">{t.listDesc}</p>
      <div className="grid gap-3.5 min-[720px]:grid-cols-2">
        {subjects.map((s) => (
          <Panel key={s.id}>
            <Link href={`/parent/subjects/${s.id}`} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[15px] font-bold">{s.name}</span>
                <span
                  className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white ${s.active ? "bg-p-success" : "bg-p-muted"}`}
                >
                  {s.active ? t.status.active : t.status.inactive}
                </span>
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
              <span className="text-[12px] font-bold text-p-primary">{t.open}</span>
            </Link>
          </Panel>
        ))}
      </div>
    </>
  );
}
