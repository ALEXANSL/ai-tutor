import { ParentModeAutoExit } from "@/components/child/ParentModeAutoExit";
import { ParentModeButton } from "@/components/child/ParentModeButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getSessionContext } from "@/server/auth/session";
import { forFamily } from "@/server/db/family-scope";
import { loadParentSettings } from "@/server/persona/service";

/** Child interface shell (Nunito, warm palette). Each page checks the role itself. */
export default async function ChildLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getSessionContext();
  const isChild = ctx.kind === "user" && ctx.role === "child";
  // BUG-004 (a): whether a PIN is set — never the hash itself — so "Режим
  // тата" can explain right away instead of after a guessed PIN attempt.
  const pinSet = isChild && ctx.kind === "user" ? !!(await loadParentSettings(forFamily(ctx.familyId))).pin_hash : false;
  return (
    <div className="min-h-screen bg-bg font-child text-text">
      <div className="fixed top-3.5 right-3.5 z-50">
        <ThemeToggle />
      </div>
      {children}
      {isChild && <ParentModeButton pinSet={pinSet} />}
      <ParentModeAutoExit active={isChild && ctx.parentMode !== "none"} />
    </div>
  );
}
