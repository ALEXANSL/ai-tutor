import { describe, expect, it } from "vitest";
import { buildLessonBlockSchema, planSchema } from "./schema";

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

/**
 * Prod incident 2026-09-28 (Bug 1): jobs at attempt 8-11/20 across many
 * DIFFERENT subjects (math, mythology, literature) were failing outright
 * with `Failed to parse structured output ... options[0].misconceptionUk:
 * Too small: expected string to have >=1 characters` whenever the model
 * returned an empty string for one wrong option's `misconceptionUk` — the
 * `.min(1)` requirement turned one missed optional field into a failure of
 * the ENTIRE block, burning a full plan+generate+review retry cycle.
 *
 * Fix: `misconceptionUk` keeps its `max(300)` cap and stays optional (an
 * absent field was always fine, ADR-028 §1), but no longer requires
 * non-empty — an empty string is exactly as acceptable as an absent field,
 * and `fillMissingMisconceptions` (pipeline.ts) papers over either case with
 * a generic fallback right after generation instead of ever failing
 * validation over it.
 */
describe("buildLessonBlockSchema — choiceStep.options[].misconceptionUk (Bug 1, 2026-09-28)", () => {
  function validBlock(misconceptionUk: string | undefined) {
    return {
      titleUk: "Порівняння дробів",
      estimatedMinutes: 7,
      hookUk: "Уяви, що піцу ділять двоє друзів...",
      visibleOutcomeUk: "Тепер ти вмієш порівнювати дроби",
      techniquesUsed: ["retrieval_practice", "concrete_to_abstract"],
      steps: [
        { type: "slide", textUk: "Уяви, що піцу ділять двоє друзів...", sourceRefs: [] },
        {
          type: "choice",
          questionUk: "Яка дріб більша?",
          options: [
            { id: "a", textUk: "1/2" },
            { id: "b", textUk: "1/4", misconceptionUk },
          ],
          correctOptionId: "a",
          explanationUk: "1/2 більша частка",
          sourceRefs: [],
        },
        { type: "slide", textUk: "Ось ще один приклад.", sourceRefs: [] },
      ],
    };
  }

  it("accepts an empty string misconceptionUk — the real failure seen in production — instead of rejecting the whole block", () => {
    const parsed = buildLessonBlockSchema([]).safeParse(validBlock(""));
    expect(parsed.success).toBe(true);
  });

  it("still accepts a fully omitted misconceptionUk, exactly as before (ADR-028 §1, ВП-37)", () => {
    const parsed = buildLessonBlockSchema([]).safeParse(validBlock(undefined));
    expect(parsed.success).toBe(true);
  });

  it("still accepts a real, non-empty misconceptionUk", () => {
    const parsed = buildLessonBlockSchema([]).safeParse(validBlock("Порівняли лише знаменники, а не самі частки"));
    expect(parsed.success).toBe(true);
  });

  it("still rejects a misconceptionUk that is well past the 300-char cap", () => {
    const parsed = buildLessonBlockSchema([]).safeParse(validBlock("а".repeat(301)));
    expect(parsed.success).toBe(false);
  });
});
