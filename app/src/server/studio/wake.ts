import "server-only";
import { after } from "next/server";
import { runStudioQueue } from "./workflow";
import { forFamily } from "@/server/db/family-scope";
import { studioActive } from "@/lib/studio";
import { readStudioProject, STUDIO_STEP } from "./store";
import { signStudioWake, studioContinuationUrl } from "./wake-auth";
/** Continuations use a derived HMAC, never the service key itself. Durable jobs remain the source of truth. */
export function kickStudio(familyId: string, projectId: string) {
  after(async () => {
    try {
      const before = await readStudioProject(familyId, projectId); if (!before || !studioActive(before.state)) return;
      await runStudioQueue(familyId, projectId, before.token);
      const project = await readStudioProject(familyId, projectId); if (!project || !studioActive(project.state)) return;
      const { data: queued, error } = await forFamily(familyId).select("jobs", "run_after").eq("type", STUDIO_STEP).eq("status", "queued").eq("payload->>projectId", projectId).eq("payload->>token", project.token).limit(1).maybeSingle<{ run_after: string }>();
      const url = studioContinuationUrl(); if (error || !queued || !url) return;
      const delay = Math.max(0, Date.parse(queued.run_after) - Date.now() + 500); if (delay > 30000) return;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (new URL(url).hostname.endsWith(".vercel.app") && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(signStudioWake({ familyId, projectId, token: project.token, at: Date.now() })), signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!response.ok) console.error("studio continuation deferred", response.status);
    } catch { console.error("studio worker deferred; durable job retained"); }
  });
}
