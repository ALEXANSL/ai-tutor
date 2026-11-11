import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireServiceRoleKey } from "@/server/env";
import { z } from "zod";
const wakeSchema = z.object({ familyId: z.string().uuid(), id: z.string().uuid(), token: z.string().uuid(), at: z.number().int(), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function signAudioWake(input: Omit<z.infer<typeof wakeSchema>, "signature">) {
  const key = createHmac("sha256", requireServiceRoleKey()).update("audiobook-wake-v1").digest();
  return { ...input, signature: createHmac("sha256", key).update(JSON.stringify([input.familyId, input.id, input.token, input.at])).digest("hex") };
}
export function validAudioWake(raw: unknown, now = Date.now()): raw is z.infer<typeof wakeSchema> {
  const parsed = wakeSchema.safeParse(raw); if (!parsed.success || Math.abs(now - parsed.data.at) > 60000) return false;
  try { return timingSafeEqual(Buffer.from(signAudioWake(parsed.data).signature, "hex"), Buffer.from(parsed.data.signature, "hex")); } catch { return false; }
}
export function audioWakeUrl() {
  const configured = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.APP_BASE_URL;
  try { const url = new URL(configured ?? ""); return url.protocol === "https:" && !url.username && !url.password ? `${url.origin}/api/audiobooks/continue` : null; } catch { return null; }
}
