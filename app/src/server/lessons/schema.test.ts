import { describe, expect, it } from "vitest";
import "@/lesson-components"; // registers drag_sort
import { getLessonComponent } from "@/lesson-components";
import { validateComponentRef } from "./component-validator";
import { buildLessonBlockSchema, materializeInteractiveProps, planSchema, type RawGeneratedBlock } from "./schema";

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

/**
 * Prod incident (job `03568fce-…`, 34h stuck, 2026-09-29/30): Anthropic
 * rejected `lesson_generation` for Математика with `400 … The compiled
 * grammar is too large … reduce the number of strict tools` — the old
 * schema put one full branch (literal component + literal v + the
 * component's own nested propsSchema) per allowed interactive component
 * straight into the model-facing `steps` union. Fix: always at most ONE
 * `interactive` branch, with a flat `component` enum and `props` as JSON
 * TEXT — independent of how many components are allowed or how complex any
 * one of them is. The component-specific shape is validated as a SECOND,
 * strict step after generation (`materializeInteractiveProps` +
 * `validateComponentRef`), never weakened — only moved.
 */
describe("buildLessonBlockSchema — interactive step shape (prod incident, grammar-size fix)", () => {
  const dragSort = getLessonComponent("drag_sort")!;
  type Def = Parameters<typeof buildLessonBlockSchema>[0][number];
  // Not actually registered (registering the same key twice throws) — only
  // `.key` is read by `buildLessonBlockSchema`, so a minimal stand-in is
  // enough to simulate "the registry grew to N components".
  const fakeComponent = (key: string): Def => ({ key } as Def);

  function branchCount(schema: ReturnType<typeof buildLessonBlockSchema>): number {
    return (schema as unknown as { def: { shape: { steps: { def: { element: { def: { options: unknown[] } } } } } } }).def.shape.steps.def.element.def.options.length;
  }

  it("offers exactly one `interactive` branch for 1 allowed component (real registry today)", () => {
    expect(branchCount(buildLessonBlockSchema([dragSort]))).toBe(4); // slide + choice + open + 1 interactive
  });

  it("STILL offers exactly one `interactive` branch for 20 allowed components — the compiled schema does not grow with the registry size (the actual fix)", () => {
    const twentyComponents = Array.from({ length: 20 }, (_, i) => fakeComponent(`fake_${i}`));
    expect(branchCount(buildLessonBlockSchema(twentyComponents))).toBe(4); // still 4, not 23
  });

  it("offers zero `interactive` branches when the subject allows no components (unchanged behavior)", () => {
    expect(branchCount(buildLessonBlockSchema([]))).toBe(3);
  });

  it("requires `component` to be one of the allowed keys and `props` to be a JSON-text string, not a nested object", () => {
    const schema = buildLessonBlockSchema([dragSort]);
    const block = {
      titleUk: "T",
      estimatedMinutes: 7,
      hookUk: "h",
      visibleOutcomeUk: "o",
      techniquesUsed: ["retrieval_practice", "concrete_to_abstract"],
      steps: [
        { type: "slide", textUk: "...", sourceRefs: [] },
        { type: "slide", textUk: "...", sourceRefs: [] },
        {
          type: "interactive",
          component: "drag_sort",
          props: JSON.stringify({
            variant: "pairs",
            instructionUk: "Спаруй",
            items: [{ id: "a", labelUk: "1/2" }],
            slots: [{ id: "s1", labelUk: "0,5" }],
            answer: { a: "s1" },
          }),
          fallbackTextUk: "fallback",
          sourceRefs: [],
        },
      ],
    };
    expect(schema.safeParse(block).success).toBe(true);

    // A nested object for `props` (the OLD shape) must now be rejected —
    // this is the schema change itself, not an incidental detail.
    const withNestedObjectProps = { ...block, steps: [block.steps[0], block.steps[1], { ...block.steps[2], props: { variant: "pairs" } }] };
    expect(schema.safeParse(withNestedObjectProps).success).toBe(false);

    // An unlisted component key must be rejected (the allow-list still
    // narrows what the model may even name).
    const withUnknownComponent = { ...block, steps: [block.steps[0], block.steps[1], { ...block.steps[2], component: "not_a_real_component" }] };
    expect(schema.safeParse(withUnknownComponent).success).toBe(false);
  });
});

describe("materializeInteractiveProps (second validation step, real component schemas — not mocked)", () => {
  it("parses a well-formed drag_sort props JSON string into a plain object that validateComponentRef then ACCEPTS", () => {
    const raw: RawGeneratedBlock = {
      titleUk: "T",
      estimatedMinutes: 7,
      hookUk: "h",
      visibleOutcomeUk: "o",
      techniquesUsed: ["retrieval_practice"],
      steps: [
        {
          type: "interactive",
          component: "drag_sort",
          props: JSON.stringify({
            variant: "pairs",
            instructionUk: "Спаруй дріб і десятковий запис",
            items: [
              { id: "a", labelUk: "1/2" },
              { id: "b", labelUk: "1/4" },
            ],
            slots: [
              { id: "s1", labelUk: "0,5" },
              { id: "s2", labelUk: "0,25" },
            ],
            answer: { a: "s1", b: "s2" },
          }),
          fallbackTextUk: "fallback",
          sourceRefs: [],
        },
      ],
    };
    const block = materializeInteractiveProps(raw);
    const step = block.steps[0];
    expect(step?.type).toBe("interactive");
    if (step?.type !== "interactive") throw new Error("expected interactive step");
    expect(typeof step.props).toBe("object"); // parsed, not the original JSON string

    const validated = validateComponentRef({ component: step.component, props: step.props, fallback_text: step.fallbackTextUk });
    expect(validated.ok).toBe(true);
  });

  it("a model that returns truncated/invalid JSON text (real failure mode this field invites) degrades to a safe fallback instead of crashing or being accepted", () => {
    const raw: RawGeneratedBlock = {
      titleUk: "T",
      estimatedMinutes: 7,
      hookUk: "h",
      visibleOutcomeUk: "o",
      techniquesUsed: ["retrieval_practice"],
      steps: [
        {
          type: "interactive",
          component: "drag_sort",
          props: '{"variant": "pairs", "items": [', // truncated — not valid JSON
          fallbackTextUk: "Обери правильну відповідь.",
          sourceRefs: [],
        },
      ],
    };
    const block = materializeInteractiveProps(raw);
    const step = block.steps[0];
    if (step?.type !== "interactive") throw new Error("expected interactive step");
    expect(step.props).toBeNull();

    const validated = validateComponentRef({ component: step.component, props: step.props, fallback_text: step.fallbackTextUk });
    expect(validated.ok).toBe(false);
    if (!validated.ok) expect(validated.fallback.type).toMatch(/choice|open/);
  });

  it("a model that returns well-formed JSON but semantically wrong props (schema mismatch) still gets caught by the SAME component schema as before", () => {
    const raw: RawGeneratedBlock = {
      titleUk: "T",
      estimatedMinutes: 7,
      hookUk: "h",
      visibleOutcomeUk: "o",
      techniquesUsed: ["retrieval_practice"],
      steps: [
        {
          type: "interactive",
          component: "drag_sort",
          // valid JSON, but only ONE item (schema requires >= 2) — the kind
          // of error the OLD single-step validation also caught, now caught
          // by the SAME `propsSchema.safeParse` just run one step later.
          props: JSON.stringify({ variant: "pairs", instructionUk: "x", items: [{ id: "a", labelUk: "1/2" }], slots: [{ id: "s1", labelUk: "0,5" }], answer: { a: "s1" } }),
          fallbackTextUk: "fallback",
          sourceRefs: [],
        },
      ],
    };
    const block = materializeInteractiveProps(raw);
    const step = block.steps[0];
    if (step?.type !== "interactive") throw new Error("expected interactive step");
    const validated = validateComponentRef({ component: step.component, props: step.props, fallback_text: step.fallbackTextUk });
    expect(validated.ok).toBe(false);
  });
});
