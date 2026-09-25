import { exitParentModeAction } from "@/app/actions/parent-mode";
import { IdleWatcher } from "@/components/parent/IdleWatcher";
import { Sidebar } from "@/components/parent/Sidebar";
import { ThemeToggle } from "@/components/ThemeToggle";
import { parentNav, sortedNav } from "@/core/registries/navigation";
import { uk } from "@/i18n/uk";
import { registerAll } from "@/modules";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { loadParentSettings } from "@/server/persona/service";

registerAll();

/**
 * Parent cabinet shell (mockup 10, NFR-A11Y-5). Access: the parent's own
 * account, or the child's tablet in PIN-unlocked parent mode (US-1.5), which
 * shows a permanent "Режим тата" badge and auto-exits when idle.
 */
export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  const access = await requireParentAccess();
  const scope = forFamily(access.familyId);
  const [{ count: unread }, settings] = await Promise.all([
    scope.count("notifications").is("read_at", null),
    loadParentSettings(scope),
  ]);
  const t = uk.parent.shell;
  const tablet = access.via === "tablet";

  const footer = tablet ? (
    <form action={exitParentModeAction} className="flex flex-col gap-2">
      <div className="rounded-xl bg-p-primary p-3 text-center text-xs font-bold text-white">{t.tabletBadge}</div>
      <button type="submit" className="min-h-11 rounded-xl border border-p-line text-sm font-bold">
        {t.exitParentMode}
      </button>
      <p className="text-center text-[11px] text-p-muted">{t.autoExitHint(settings.parent_mode_idle_min)}</p>
    </form>
  ) : (
    <form action="/auth/signout" method="post">
      <button type="submit" className="min-h-11 w-full rounded-xl border border-p-line text-sm font-bold">
        {t.signOut}
      </button>
    </form>
  );

  return (
    <div className="min-h-screen bg-p-bg font-parent text-p-text min-[820px]:grid min-[820px]:grid-cols-[240px_1fr]">
      {tablet && (
        <>
          <div
            role="status"
            className="fixed top-3 left-1/2 z-[95] -translate-x-1/2 rounded-full bg-p-primary px-3.5 py-2 text-xs font-bold text-white shadow"
          >
            {t.tabletBadge}
          </div>
          <IdleWatcher idleMinutes={settings.parent_mode_idle_min} />
        </>
      )}
      <Sidebar items={sortedNav(parentNav.list())} unread={unread ?? 0} footer={footer} />
      <div className="px-4 pt-16 pb-16 min-[820px]:px-6.5 min-[820px]:pt-6">
        <div className="mb-4 flex justify-end">
          <ThemeToggle variant="parent" />
        </div>
        {children}
      </div>
    </div>
  );
}
