import { expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => { const chain = { eq: () => chain, order: () => chain, limit: () => chain, returns: async () => ({ data: f.rows, error: null }) }; return chain; } }) }));
import { illustrationFailureReason, loadIllustrationFailures } from "./illustration-failures";

it("shows only the HTTP code and a plain reason, never the provider's own text", () => {
  expect(illustrationFailureReason("image_generation_failed (HTTP 403): secret org id org-123")).toEqual({ code: 403, reason: expect.stringContaining("доступу") });
  expect(JSON.stringify(illustrationFailureReason("image_generation_failed (HTTP 403): secret org id org-123"))).not.toContain("org-123");
  expect(illustrationFailureReason("image_result_uncertain; conservative estimate: x").reason).toBe("сервіс не підтвердив результат");
});

it("names a known provider cause without showing the provider's text", () => {
  const result = illustrationFailureReason("image_generation_failed (HTTP 403): x [provider: {\"error\":{\"message\":\"Your organization org-9 must be verified to use gpt-image-1\"}}]");
  expect(result.code).toBe(403); expect(result.reason).toMatch(/верифікувати/); expect(JSON.stringify(result)).not.toContain("org-9");
});

it("groups failures since the last successful picture by service", async () => {
  f.rows = [
    { provider: "gemini", model: "g", status: "error", error: "image_generation_failed (HTTP 429): q" },
    { provider: "openai", model: "o", status: "error", error: "image_generation_failed (HTTP 403): v" },
    { provider: "gemini", model: "g", status: "error", error: "image_generation_failed (HTTP 429): q" },
    { provider: "gemini", model: "g", status: "ok", error: null },
    { provider: "gemini", model: "g", status: "error", error: "image_generation_failed (HTTP 404): old" },
  ];
  expect(await loadIllustrationFailures("fam", "deck")).toEqual([
    { provider: "gemini", model: "g", code: 429, reason: expect.any(String), count: 2 },
    { provider: "openai", model: "o", code: 403, reason: expect.any(String), count: 1 },
  ]);
});

it("recognises a Gemini key on the free tier", () => {
  const result = illustrationFailureReason("image_generation_failed (HTTP 429): x [provider: {\"error\":{\"message\":\"Quota exceeded for metric: generate_content_free_tier_requests, limit: 0\"}}]");
  expect(result.code).toBe(429); expect(result.reason).toMatch(/білінг/); expect(result.reason).toMatch(/безкоштовному/);
});
