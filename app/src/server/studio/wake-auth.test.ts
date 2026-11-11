import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/server/env", () => ({ requireServiceRoleKey: () => "test-only-signing-key" }));
import { signStudioWake, validStudioWake, studioContinuationUrl } from "./wake-auth";
const input = { familyId: "11111111-1111-4111-8111-111111111111", projectId: "22222222-2222-4222-8222-222222222222", token: "33333333-3333-4333-8333-333333333333", at: Date.now() };
afterEach(() => vi.unstubAllEnvs());
it("authenticates only a current, untampered continuation and transmits no service key", () => {
  const signed = signStudioWake(input); expect(validStudioWake(signed, input.at)).toBe(true);
  expect(JSON.stringify(signed)).not.toContain("test-only-signing-key");
  expect(validStudioWake({ ...signed, projectId: input.familyId }, input.at)).toBe(false);
  expect(validStudioWake(signed, input.at + 61000)).toBe(false); expect(validStudioWake(null)).toBe(false);
});
it("prefers the current Vercel project's production host over a shared OAuth host and refuses insecure callback origins", () => {
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "example.vercel.app"); vi.stubEnv("APP_BASE_URL", "https://another.invalid");
  expect(studioContinuationUrl()).toBe("https://example.vercel.app/api/studio/continue");
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", ""); vi.stubEnv("APP_BASE_URL", "http://localhost:3000"); expect(studioContinuationUrl()).toBeNull();
});
