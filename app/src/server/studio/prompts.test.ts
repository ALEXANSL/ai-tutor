import { expect, it } from "vitest";
import { studioDesignSchema, studioReviewResponseSchema, studioReviewSchema } from "@/lib/studio";
import { studioSystem } from "./prompts";
import { studioVisualFixture } from "./__fixtures__/project";
it("shares the actual visual contract across all agents without imposing diagram quotas", () => {
  for (const role of ["studio.author", "studio.design", "studio.review"] as const) {
    const system = studioSystem(role);
    expect(system).toContain('width=null, height=null, unit="" — КОРЕКТНО');
    expect(system).toContain("Markdown-таблиця є повноцінним");
    expect(system).toContain("обов’язкового мінімуму немає");
  }
  expect(studioDesignSchema.safeParse({ visuals: [] }).success).toBe(true);
  expect(studioDesignSchema.safeParse({ visuals: Array.from({ length: 3 }, () => studioVisualFixture) }).success).toBe(true);
});
it("keeps legacy saved reviews readable but requires actionable instructions from new reviews", () => {
  const legacy = { verdict: "revise", issues: ["Уточни приклад"], summary: "Зміни" };
  expect(studioReviewSchema.safeParse(legacy).success).toBe(true);
  expect(studioReviewResponseSchema.safeParse(legacy).success).toBe(false);
  const json = studioReviewResponseSchema.toJSONSchema();
  expect(json.required).toContain("corrections");
});

it("teaches the subject beyond textbook wording while preserving curriculum alignment and factual review", () => {
  for (const role of ["studio.plan", "studio.author", "studio.review"] as const) {
    const system = studioSystem(role);
    expect(system).toContain("не межа знань");
    expect(system).toContain("зв’язок зі шкільною програмою");
    expect(system).toContain("НЕ є помилкою");
    expect(system).toContain("Уточнюй помилки або застарілі твердження");
  }
});
it("asks for Ukrainian explanations and native English/German listening rather than transliteration", () => {
  for (const role of ["studio.author", "studio.review"] as const) {
    const system = studioSystem(role); expect(system).toContain("en-GB"); expect(system).toContain("de-DE"); expect(system).toContain("кириличну транслітерацію"); expect(system).toContain("Самі питання без навчального матеріалу недостатні");
  }
});
