import Link from "next/link";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { loadParentSettings } from "@/server/persona/service";
import { PageTitle, Panel } from "./ui";

/** Dashboard (mockup 10) — empty until lessons exist; unread counter on the first screen (US-11.6 KP-2). */
export default async function ParentDashboard() {
  const { familyId } = await requireParentAccess();
  const scope = forFamily(familyId);
  const [{ count: unread }, { data: child }, settings] = await Promise.all([
    scope.count("notifications").is("read_at", null),
    scope.select("child_profile", "nickname, tutor_name").limit(1).maybeSingle<Pick<ChildProfileRow, "nickname" | "tutor_name">>(),
    loadParentSettings(scope),
  ]);
  const t = uk.parent.dashboard;

  return (
    <>
      <PageTitle
        action={
          <Link href="/parent/books" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-p-primary px-3.5 text-[13px] font-bold text-white">
            {t.addBook}
          </Link>
        }
      >
        {t.title}
      </PageTitle>

      <div className="mb-5 grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
        <div className="rounded-2xl border border-p-line bg-p-surface px-4.5 py-4">
          <div className="text-xs font-bold uppercase text-p-muted">{t.today}</div>
          <div className="mt-1.5 text-lg font-bold">{t.todayEmpty}</div>
        </div>
        <Link href="/parent/notifications" className="rounded-2xl border border-p-line bg-p-surface px-4.5 py-4">
          <div className="text-xs font-bold uppercase text-p-muted">{t.unread}</div>
          <div className="mt-1.5 text-2xl font-extrabold">{unread ?? 0}</div>
          <div className="mt-1 text-xs text-p-primary">{t.openNotifications}</div>
        </Link>
      </div>

      <div className="grid gap-4 min-[980px]:grid-cols-[1.4fr_1fr]">
        <Panel title={t.summaryTitle}>
          <p className="text-sm text-p-muted">{t.summaryEmpty}</p>
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
