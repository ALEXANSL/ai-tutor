import Link from "next/link";
import { childTiles, sortedNav } from "@/core/registries/navigation";
import { uk } from "@/i18n/uk";
import { registerAll } from "@/modules";
import { requireChild } from "@/server/auth/guards";
import type { SubjectRow } from "@/server/db/types";
import { createUserClient } from "@/server/supabase/clients";

registerAll();

const tileBase = "flex min-h-24 flex-col items-center justify-center rounded-2xl border-2 border-transparent bg-surface-alt px-3 py-3.5 text-center";

/**
 * "Today" (mockup 02): greeting by nickname, empty plan for now, subject
 * tiles from data (8 MVP subjects inactive until their slices, 2 stubs with a
 * "coming soon" screen — US-3.4) and the inactive modules tile (US-11.8 KP-3).
 */
export default async function TodayPage() {
  const { profile } = await requireChild();
  const supabase = await createUserClient();
  const { data: subjects } = await supabase
    .from("subjects")
    .select("id, code, name_uk, active, is_stub, sort_order, config")
    .order("sort_order")
    .returns<SubjectRow[]>();
  const t = uk.child.today;

  return (
    <div className="pb-28">
      <header className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5 pb-2 pr-40">
        <div>
          <h1 className="mb-1 text-2xl font-extrabold">{t.greeting(profile.nickname ?? "")}</h1>
          <p className="text-sm text-muted">{t.subtitle}</p>
        </div>
      </header>

      <nav className="flex flex-wrap gap-2.5 px-6 pb-3.5">
        <Link href="/my-tutor" className="flex min-h-12 items-center gap-1.5 rounded-2xl border border-line bg-surface px-4 text-sm font-bold">
          {t.myTutor}
        </Link>
        <Link href="/about-ai" className="flex min-h-12 items-center gap-1.5 rounded-2xl border border-line bg-surface px-4 text-sm font-bold">
          {t.aboutAi}
        </Link>
      </nav>

      <main className="grid grid-cols-1 gap-5 px-6 pt-3 landscape:min-[900px]:grid-cols-[1.15fr_0.85fr] landscape:min-[900px]:items-start">
        <section className="rounded-[22px] bg-[linear-gradient(120deg,var(--accent-voice),var(--primary))] p-6 text-white shadow-lg">
          <b className="block text-lg">{t.emptyPlanTitle}</b>
          <span className="text-sm opacity-90">{t.emptyPlanBody}</span>
        </section>

        <aside className="rounded-[22px] border border-line bg-surface p-4.5">
          <h2 className="mb-1 text-lg font-bold">{t.subjectsTitle}</h2>
          <p className="mb-3.5 text-sm text-muted">{t.subjectsSubtitle}</p>
          <div className="grid grid-cols-2 gap-2.5 min-[1200px]:grid-cols-3">
            {(subjects ?? []).map((s) => {
              const label = (
                <>
                  <span className="mb-1.5 block text-2xl" aria-hidden="true">
                    {s.config.icon ?? "📘"}
                  </span>
                  <b className="block text-[13px]">{s.config.shortNameUk ?? s.name_uk}</b>
                </>
              );
              if (s.is_stub) {
                return (
                  <Link key={s.id} href={`/soon/${s.code}`} className={`${tileBase} opacity-60`}>
                    {label}
                    <span className="text-[11px] text-muted">{t.soon}</span>
                  </Link>
                );
              }
              if (s.active) {
                // Activated subjects open their lessons from S2/S3 on.
                return (
                  <div key={s.id} className={`${tileBase} border-secondary`}>
                    {label}
                  </div>
                );
              }
              return (
                <div key={s.id} aria-disabled="true" className={`${tileBase} opacity-55`}>
                  {label}
                </div>
              );
            })}
            {sortedNav(childTiles.list()).map((tile) => (
              <div key={tile.key} aria-disabled="true" className={`${tileBase} cursor-default opacity-55`}>
                <span className="mb-1.5 block text-2xl" aria-hidden="true">
                  {tile.icon}
                </span>
                <b className="block text-[13px]">{tile.label}</b>
                <span className="text-[11px] text-muted">{t.soon}</span>
              </div>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}
