import "server-only";
import { after } from "next/server";
import { audioRunning } from "@/lib/audiobooks";
import { runAudioPart } from "./workflow";
import { readAudioPart } from "./store";
import { signAudioWake, audioWakeUrl } from "./wake-auth";
export function kickAudioPart(familyId: string, id: string) {
  after(async () => {
    try {
      const before = await readAudioPart(familyId, id); if (!before || !audioRunning(before)) return;
      await runAudioPart(familyId, id, before.token);
      const current = await readAudioPart(familyId, id); const url = audioWakeUrl();
      if (!current || !audioRunning(current) || current.token !== before.token || current.leaseUntil > Date.now() || !url) return;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (new URL(url).hostname.endsWith(".vercel.app") && process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
      const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(signAudioWake({ familyId, id, token: current.token, at: Date.now() })), signal: AbortSignal.timeout(10000), redirect: "error" });
      if (!response.ok) console.error("audiobook continuation deferred", response.status);
    } catch { console.error("audiobook worker deferred; document retained"); }
  });
}
