import "server-only";
import { z } from "zod";
import type { LessonComponentDefinition } from "@/lesson-components/registry";
import { PEDAGOGY_TECHNIQUE_KEYS, REVIEW_CRITERIA } from "./pedagogy";

/**
 * Structured-output schema for the `lesson_generation` role (ADR-020 §3):
 * the model returns data only — text, options, citations, and (for
 * `interactive` steps) a component key + its own `props` schema — never
 * markup. Built per call from the subject's `allowed_components` so the
 * model is never even offered a component it is not allowed to use.
 *
 * The manual `GeneratedStep` union below (rather than a type inferred from
 * the dynamically-built Zod schema) keeps the rest of the code simply typed;
 * `buildLessonBlockSchema` is asserted to produce exactly this shape, which
 * its own fields make true by construction.
 */
export interface SourceRefOut {
  materialId: string;
  materialTitle: string;
  page: number | null;
}
export interface SlideStepOut {
  type: "slide";
  textUk: string;
  exampleUk?: string;
  sourceRefs: SourceRefOut[];
}
export interface ChoiceStepOut {
  type: "choice";
  questionUk: string;
  options: { id: string; textUk: string }[];
  correctOptionId: string;
  explanationUk: string;
  sourceRefs: SourceRefOut[];
}
export interface OpenStepOut {
  type: "open";
  questionUk: string;
  expectedAnswerUk: string;
  rubricUk: string;
  sourceRefs: SourceRefOut[];
}
export interface InteractiveStepOut {
  type: "interactive";
  component: string;
  v: number;
  props: unknown;
  fallbackTextUk: string;
  sourceRefs: SourceRefOut[];
}
export type GeneratedStep = SlideStepOut | ChoiceStepOut | OpenStepOut | InteractiveStepOut;
export interface LessonBlockGenerated {
  titleUk: string;
  estimatedMinutes: number;
  /** US-6.12: the opening line the first `slide` step must actually be. */
  hookUk: string;
  /** US-6.13: "тепер ти вмієш…" — shown at the block's end, not a step. */
  visibleOutcomeUk: string;
  /** Keys from `PEDAGOGY_TECHNIQUES` actually applied (US-6.9 КП-2, ≥ 2). */
  techniquesUsed: string[];
  steps: GeneratedStep[];
}

/** `lesson_planning` role output (ADR-022 step 1) — the methodical plan a block is built from. */
export interface LessonPlan {
  goalUk: string;
  hookUk: string;
  visibleOutcomeUk: string;
  techniques: { key: string; whyUk: string }[];
  misconceptionsUk: string[];
  toneNotesUk: string;
  comprehensionChecksUk: string[];
}

export const planSchema: z.ZodType<LessonPlan> = z.object({
  // BUG-018: the model is asked for "one sentence" but real one-sentence
  // goals in Ukrainian (with a subordinate clause, as this phrasing tends
  // to produce) regularly ran past the original 200-char cap — a purely
  // cosmetic overage that should never fail a whole lesson generation.
  // 400 gives real headroom for a slightly-long-but-correct sentence while
  // still rejecting a genuinely bloated one (a paragraph, several
  // sentences); the prompt below also asks for a hard budget so this
  // ceiling is rarely the thing actually doing the work.
  goalUk: z.string().min(1).max(400),
  hookUk: z.string().min(1).max(400),
  visibleOutcomeUk: z.string().min(1).max(200),
  techniques: z
    .array(z.object({ key: z.enum(PEDAGOGY_TECHNIQUE_KEYS), whyUk: z.string().min(1).max(250) }))
    .min(2)
    .max(5),
  misconceptionsUk: z.array(z.string().min(1).max(250)).min(1).max(5),
  toneNotesUk: z.string().min(1).max(400),
  comprehensionChecksUk: z.array(z.string().min(1).max(250)).min(1).max(4),
});

/** `lesson_review` role output (ADR-022 step 3): 0–2 per rubric criterion. */
const reviewScoresShape = Object.fromEntries(REVIEW_CRITERIA.map((c) => [c, z.number().int().min(0).max(2)])) as Record<
  (typeof REVIEW_CRITERIA)[number],
  z.ZodNumber
>;
export const reviewSchema = z.object({
  verdict: z.enum(["approved", "revise", "rejected"]),
  scores: z.object(reviewScoresShape),
  notes: z.array(z.string().min(1).max(300)).max(6),
  summaryUk: z.string().min(1).max(400),
});
export type ReviewOutput = z.infer<typeof reviewSchema>;

const sourceRefSchema = z.object({
  materialId: z.string().uuid(),
  materialTitle: z.string().min(1).max(200),
  page: z.number().int().min(1).max(5000).nullable(),
});

const baseStep = {
  sourceRefs: z.array(sourceRefSchema).max(3),
};

const slideStep = z.object({
  type: z.literal("slide"),
  textUk: z.string().min(1).max(900),
  exampleUk: z.string().max(400).optional(),
  ...baseStep,
});

const choiceStep = z.object({
  type: z.literal("choice"),
  questionUk: z.string().min(1).max(400),
  options: z.array(z.object({ id: z.string().min(1).max(10), textUk: z.string().min(1).max(200) })).min(2).max(5),
  correctOptionId: z.string().min(1).max(10),
  explanationUk: z.string().min(1).max(300),
  ...baseStep,
});

const openStep = z.object({
  type: z.literal("open"),
  questionUk: z.string().min(1).max(400),
  expectedAnswerUk: z.string().min(1).max(300),
  rubricUk: z.string().min(1).max(300),
  ...baseStep,
});

export function buildLessonBlockSchema(allowedComponents: LessonComponentDefinition<never, never>[]): z.ZodType<LessonBlockGenerated> {
  const interactiveVariants = allowedComponents.map((def) =>
    z.object({
      type: z.literal("interactive"),
      component: z.literal(def.key),
      v: z.literal(def.v),
      props: def.propsSchema as z.ZodType,
      fallbackTextUk: z.string().min(1).max(300),
      ...baseStep,
    }),
  );
  const stepSchema = z.discriminatedUnion("type", [slideStep, choiceStep, openStep, ...interactiveVariants] as never);

  return z.object({
    titleUk: z.string().min(1).max(150),
    estimatedMinutes: z.number().int().min(5).max(10),
    hookUk: z.string().min(1).max(400),
    visibleOutcomeUk: z.string().min(1).max(200),
    techniquesUsed: z.array(z.enum(PEDAGOGY_TECHNIQUE_KEYS)).min(2).max(5),
    // NFR-SAFE-8 / US-19.1 КП-2: the model is never told the nickname; if it
    // reaches for one anyway, the validator below catches the placeholder.
    steps: z.array(stepSchema).min(3).max(10),
  }) as unknown as z.ZodType<LessonBlockGenerated>;
}
