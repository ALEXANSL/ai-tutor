import { redirect } from "next/navigation";
import { getSessionContext } from "@/server/auth/session";

/** Entry point of the installed PWA: route by who is signed in (US-1.2 KP-1). */
export default async function Home() {
  const ctx = await getSessionContext();
  if (ctx.kind === "user") redirect(ctx.role === "parent" || ctx.parentMode === "active" ? "/parent" : "/today");
  if (ctx.kind === "forbidden") redirect("/no-access");
  redirect(ctx.kind === "not_configured" ? "/login?error=config" : "/login");
}
