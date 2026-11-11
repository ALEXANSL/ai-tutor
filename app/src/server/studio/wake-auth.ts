import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireServiceRoleKey } from "@/server/env";
const uuid = /^[a-f0-9-]{36}$/i;
export interface StudioWake { familyId: string; projectId: string; token: string; at: number; signature: string; }
export function signStudioWake(input: Omit<StudioWake, "signature">): StudioWake {
  const key = createHmac("sha256", requireServiceRoleKey()).update("studio-wake-v1").digest();
  const signature = createHmac("sha256", key).update(JSON.stringify([input.familyId, input.projectId, input.token, input.at])).digest("hex"); return { ...input, signature };
}
export function validStudioWake(raw: unknown, now = Date.now()): raw is StudioWake {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as StudioWake;
  if (![value.familyId, value.projectId, value.token].every(id => typeof id === "string" && uuid.test(id)) || !Number.isSafeInteger(value.at) || Math.abs(now - value.at) > 60000 || typeof value.signature !== "string" || !/^[a-f0-9]{64}$/.test(value.signature)) return false;
  try { const expected = signStudioWake({ familyId: value.familyId, projectId: value.projectId, token: value.token, at: value.at }); return timingSafeEqual(Buffer.from(expected.signature, "hex"), Buffer.from(value.signature, "hex")); } catch { return false; }
}
export function studioContinuationUrl(): string | null {
  const configured = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.APP_BASE_URL || "";
  try { const url = new URL(configured); return url.protocol === "https:" && !url.username && !url.password ? `${url.origin}/api/studio/continue` : null; } catch { return null; }
}
