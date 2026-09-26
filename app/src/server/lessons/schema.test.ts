import { describe, expect, it } from "vitest";
import { planSchema } from "./schema";

/**
 * BUG-018 (Major): `startLessonAction failed: anthropic call failed:
 * Failed to parse structured output ... goalUk: Too big: expected string
 * to have <=200 characters`. The `lesson_planning` model is asked for
 * "one sentence" but a real, content-correct Ukrainian sentence (with a
 * subordinate clause, as this phrasing regularly produces) went past the
 * original 200-char cap and failed the whole lesson generation — a purely
 * cosmetic overage should never do that.
 *
 * Fix: the cap on `goalUk` moved to 400 (comfortable headroom for a
 * slightly-long-but-correct one-sentence goal), and the prompt
 * (`prompts/lesson_planning.md`) now asks for a ~150-char budget with an
 * example, so the model rarely needs the extra room in practice.
 */
function validPlan(goalUk: string) {
  return {
    goalUk,
    hookUk: "Уяви, що піцу ділять двоє друзів...",
    visibleOutcomeUk: "Тепер ти вмієш порівнювати дроби",
    techniques: [
      { key: "retrieval_practice", whyUk: "спершу пригадування" },
      { key: "concrete_to_abstract", whyUk: "від піци до правила" },
    ],
    misconceptionsUk: ["діти порівнюють лише чисельники"],
    toneNotesUk: "тепло, без осуду",
    comprehensionChecksUk: ["чи вміє порівняти дві дроби"],
  };
}

describe("planSchema.goalUk (BUG-018)", () => {
  it("a 201-character goalUk — exactly the length that broke production under the old <=200 cap — is now accepted", () => {
    // A real-looking, content-correct one-sentence goal that just happens to
    // run one subordinate clause too long, the way the model actually wrote
    // it: 201 characters.
    const goalUk =
      "Дитина навчиться порівнювати звичайні дроби з різними знаменниками, приводячи їх до спільного знаменника, а також розуміти, чому саме цей спосіб порівняння працює коректно для будь-яких додатних дробів.".slice(
        0,
        201,
      );
    expect(goalUk).toHaveLength(201);
    const parsed = planSchema.safeParse(validPlan(goalUk));
    expect(parsed.success).toBe(true);
  });

  it("still rejects a genuinely bloated goalUk (well past a real sentence, e.g. a full paragraph)", () => {
    const goalUk = "Дуже довге речення, що імітує ціле речення. ".repeat(20); // ~900 chars
    expect(goalUk.length).toBeGreaterThan(400);
    const parsed = planSchema.safeParse(validPlan(goalUk));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(["goalUk"]);
    }
  });

  it("still rejects an empty goalUk", () => {
    const parsed = planSchema.safeParse(validPlan(""));
    expect(parsed.success).toBe(false);
  });
});
