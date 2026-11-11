import { expect, it, vi } from "vitest";
vi.mock("@/server/env", () => ({ requireServiceRoleKey: () => "test-only-not-a-secret" }));
import { audioWakeUrl, signAudioWake, validAudioWake } from "./wake-auth";
const value = { familyId: "11111111-1111-4111-8111-111111111111", id: "22222222-2222-4222-8222-222222222222", token: "33333333-3333-4333-8333-333333333333", at: 100000 };
it("rejects forged, tampered and stale continuations before any worker read", () => {
  const signed = signAudioWake(value); expect(validAudioWake(signed, value.at)).toBe(true); expect(JSON.stringify(signed)).not.toContain("test-only");
  expect(validAudioWake({ ...signed, id: value.familyId }, value.at)).toBe(false); expect(validAudioWake(signed, value.at + 60001)).toBe(false); expect(validAudioWake({ ...signed, signature: "x" }, value.at)).toBe(false); expect(validAudioWake(null)).toBe(false);
});
it("uses own production project URL instead of another app host", () => { vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "ai-tutor-8zmb.vercel.app"); vi.stubEnv("APP_BASE_URL", "https://another.example"); expect(audioWakeUrl()).toBe("https://ai-tutor-8zmb.vercel.app/api/audiobooks/continue"); vi.unstubAllEnvs(); });
