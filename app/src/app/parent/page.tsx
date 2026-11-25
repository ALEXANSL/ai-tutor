import Link from "next/link";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { FolderAccessBanner } from "@/components/parent/books/FolderAccessBanner";
import { getFolderAccessStatus } from "@/server/drive/service";
import { loadParentSettings } from "@/server/persona/service";
import { listSchoolEntries } from "@/server/eschool/store";
import { loadBudgetDashboard } from "@/server/budget/queries";
import { voiceActor } from "@/server/voice/service";
import { homeworkSummary } from "@/lib/homework-summary";
import { studioCatalog } from "@/server/studio/catalog";
import { studioActive, studioStateLabels } from "@/lib/studio";
import { PageTitle, Panel } from "./ui";

/** Overview (D-131/D-132): real homework, AI Studio queue, spend and notifications — no fixed placeholder texts. */
export default async function ParentDashboard() {
  const { familyId } = await requireParentAccess();
  const scope = forFamily(familyId);
  const [{ count: unread }, { data: child }, settings, access, homework, budget, studio] = await Promise.all([
    scope.count("notifications").is("read_at", null),
    scope.select("child_profile", "nickname, tutor_name").limit(1).maybeSingle<Pick<ChildProfileRow, "nickname" | "tutor_name">>(),
    loadParentSettings(scope),
    getFolderAccessStatus(familyId),
    voiceActor(familyId).then(({ child }) => listSchoolEntries(familyId, child.id)).then(r => homeworkSummary(r.entries)).catch(() => null),
    loadBudgetDashboard(familyId).catch(() => null),
    studioCatalog(familyId, { q: "", subject: "", page: 0 }).catch(() => null),
  ]);
  // Read-only: the overview never wakes or resumes Studio work.
  const studioItems = studio?.items ?? [];
  const working = studioItems.filter(item => studioActive(item.state));
  const review = studioItems.filter(item => item.state === "ready" || item.state === "needs_changes");
  const t = uk.parent.dashboard;

  return (
    <>
      <PageTitle
        action={
          <Link href="/parent/studio?tab=book" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-p-primary px-3.5 text-[13px] font-bold text-white">
            {t.addBook}
          </Link>
        }
      >
        {t.title}
      </PageTitle>
      {/* US-2.1 KP-2: the warning is shown in the cabinet, not only in "Мої книги". */}
      <FolderAccessBanner status={access} />

      <div className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        <Link href="/parent/school" className="rounded-2xl border border-p-line bg-p-surface px-4.5 py-4">
          <div className="text-xs font-bold uppercase text-p-muted">Домашні завдання</div>
          {homework ? (
            <>
              <div className="mt-1.5 text-2xl font-extrabold">{homework.overdue + homework.today}</div>
              <div className="mt-1 text-xs text-p-muted">
                {homework.overdue > 0 ? `Прострочено: ${homework.overdue} · ` : ""}На сьогодні: {homework.today} · Незабаром: {homework.soon}
              </div>
            </>
          ) : (
            <div className="mt-1.5 text-sm text-p-muted">Щоденник ще не підключено або він недоступний</div>
          )}
          <div className="mt-1 text-xs text-p-primary">Відкрити «Школу» ▸</div>
        </Link>
        <Link href="/parent/notifications" className="rounded-2xl border border-p-line bg-p-surface px-4.5 py-4">
          <div className="text-xs font-bold uppercase text-p-muted">{t.unread}</div>
          <div className="mt-1.5 text-2xl font-extrabold">{unread ?? 0}</div>
          <div className="mt-1 text-xs text-p-primary">{t.openNotifications}</div>
        </Link>
        <Link href="/parent/budget" className="rounded-2xl border border-p-line bg-p-surface px-4.5 py-4">
          <div className="text-xs font-bold uppercase text-p-muted">Витрати ШІ цього місяця</div>
          {budget ? (
            <>
              <div className="mt-1.5 text-2xl font-extrabold">${budget.forecast.spentUsd.toFixed(2)}</div>
              <div className="mt-1 text-xs text-p-muted">з ${budget.forecast.limitUsd.toFixed(0)} · прогноз ${budget.forecast.forecastUsd.toFixed(2)}</div>
            </>
          ) : (
            <div className="mt-1.5 text-sm text-p-muted">Не вдалося завантажити витрати</div>
          )}
          <div className="mt-1 text-xs text-p-primary">Бюджет і моделі ▸</div>
        </Link>
      </div>

      {homework && homework.open.length > 0 && (
        <Panel title="Найближчі домашні завдання">
          <ul className="space-y-2">
            {homework.open.map((item) => (
              <li key={item.id} className="rounded-xl border border-p-line p-3 text-[13px]">
                <b>{item.subject}</b> · <span className="text-p-muted">{item.due}</span>
                {item.text && <p className="mt-1 line-clamp-2 text-p-muted">{item.text}</p>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="grid gap-4 min-[980px]:grid-cols-[1.4fr_1fr]">
        <Panel title="Майстерня ШІ">
          {studio ? (
            <p className="mb-3 text-sm">Готуються: <b>{working.length}</b> · Чекають на твій перегляд: <b>{review.length}</b></p>
          ) : (
            <p className="mb-3 text-sm text-p-muted">Не вдалося завантажити стан Майстерні.</p>
          )}
          {[...review, ...working].slice(0, 4).map(item => (
            <Link key={item.id} href={`/parent/studio/${item.id}`} className="mb-2 block rounded-xl border border-p-line p-3 text-[13px]">
              <b>{item.title}</b> · <span className="text-p-muted">{studioStateLabels[item.state]}</span>
            </Link>
          ))}
          <Link href="/parent/studio/new" className="mt-3 inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-sm font-bold text-white">Створити урок у Майстерні</Link>
        </Panel>
        <Panel title={t.stateTitle}>
          <dl className="text-[13px]">
            {[
              [t.childNickname, child?.nickname ?? t.notChosenYet],
              [t.tutorName, child?.tutor_name ?? t.notChosenYet],
              [t.pinState, settings.pin_hash ? t.pinSet : t.pinNotSet],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3 border-b border-p-line py-2.5 last:border-b-0">
                <dt className="text-p-muted">{k}</dt>
                <dd className="text-right font-bold">{v}</dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>
    </>
  );
}
