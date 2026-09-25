import { ParentModeAutoExit } from "@/components/child/ParentModeAutoExit";
import { ParentModeButton } from "@/components/child/ParentModeButton";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getSessionContext } from "@/server/auth/session";

/** Child interface shell (Nunito, warm palette). Each page checks the role itself. */
export default async function ChildLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getSessionContext();
  const isChild = ctx.kind === "user" && ctx.role === "child";
  return (
    <div className="min-h-screen bg-bg font-child text-text">
      <div className="fixed top-3.5 right-3.5 z-50">
        <ThemeToggle />
      </div>
      {children}
      {isChild && <ParentModeButton />}
      <ParentModeAutoExit active={isChild && ctx.parentMode !== "none"} />
    </div>
  );
}
