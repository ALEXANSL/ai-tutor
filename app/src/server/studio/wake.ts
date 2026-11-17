import "server-only";
import { after } from "next/server";
import { resumeLegacyStudioReview, runStudioQueue } from "./workflow";
import { forFamily } from "@/server/db/family-scope";
import { studioActive } from "@/lib/studio";
import { readStudioProject, STUDIO_STEP } from "./store";
import { signStudioWake, studioContinuationUrl } from "./wake-auth";
/** Network-only handoff fits the generic tick's remaining ~30 seconds. Never run another model in that invocation. */
export function dispatchStudioContinuation(familyId: string, projectId: string, token: string) {
  after(() => requestStudioContinuation(familyId, projectId, token));
}
async function requestStudioContinuation(familyId: string, projectId: string, token: string) {
  const url = studioContinuationUrl(); if (!url) return;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (new URL(url).hostname.endsWith(".vercel.app") && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  // A POST may be accepted even if its response is lost. Project token/lease CAS makes only this handoff safe to retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(signStudioWake({ familyId, projectId, token, at: Date.now() })), signal: AbortSignal.timeout(6000), redirect: "error" });
      if (response.ok) return;
      if (![429, 500, 502, 503, 504].includes(response.status)) { console.error("studio continuation deferred", response.status); return; }
    } catch { /* No paid model call is repeated here. */ }
    if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  console.error("studio continuation deferred; durable job retained");
}
/** Parent actions and /api/studio/continue have a fresh 300-second invocation budget. */
export function kickStudio(familyId: string, projectId: string) {
  after(async () => {
    try {
      const before = await resumeLegacyStudioReview(familyId, projectId); if (!before || !studioActive(before.state)) return;
      await runStudioQueue(familyId, projectId, before.token);
      const project = await readStudioProject(familyId, projectId); if (!project || !studioActive(project.state)) return;
      const { data: queued, error } = await forFamily(familyId).select("jobs", "run_after").eq("type", STUDIO_STEP).eq("status", "queued").eq("payload->>projectId", projectId).eq("payload->>token", project.token).limit(1).maybeSingle<{ run_after: string }>();
      if (error || !queued) return;
      const delay = Math.max(0, Date.parse(queued.run_after) - Date.now() + 500); if (delay > 30000) return;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      await requestStudioContinuation(familyId, projectId, project.token);
    } catch { console.error("studio worker deferred; durable job retained"); }
  });
}
