import "server-only";
import { after } from "next/server";
import { deckWakeToken } from "./wake-auth";
import { ensureJobHandlers } from "@/server/jobs/kick";
import { runJobs } from "@/server/jobs/runner";
import { forFamily } from "@/server/db/family-scope";
import { getDeck, WORK_TYPE } from "./store";

export function kickDeck(familyId: string, id: string) {
  after(async () => {
    ensureJobHandlers();
    await runJobs({ budgetMs: 120000, target: { familyId, type: WORK_TYPE, dedupeKey: `${WORK_TYPE}:${id}` } });
    if ((await getDeck(familyId, id))?.state !== "processing") return;
    const { data: pending } = await forFamily(familyId).select("jobs", "run_after").eq("type", WORK_TYPE)
      .eq("dedupe_key", `${WORK_TYPE}:${id}`).eq("status", "queued").maybeSingle<{ run_after: string }>();
    if (!pending) return;
    const host = (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) || process.env.VERCEL_URL;
    if (!host || !/^[a-z0-9.-]+\.vercel\.app$/i.test(host)) return;
    // A transient failure is requeued by the runner with a short backoff.
    const delay = Math.max(0, Date.parse(pending.run_after) - Date.now());
    if (delay > 60000) return;
    if (delay) await new Promise<void>(resolve => setTimeout(resolve, delay));
    const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${deckWakeToken(familyId, id)}` };
    if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    const response = await fetch(`https://${host}/api/presentations/continue`, { method: "POST", headers, redirect: "error", body: JSON.stringify({ familyId, id }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) console.warn("Presentation continuation deferred to jobs tick", response.status);
  });
}
