import "server-only";
import { z } from "zod";
import type { LessonComponentDefinition } from "@/lesson-components/registry";

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
  steps: GeneratedStep[];
}

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
    // NFR-SAFE-8 / US-19.1 КП-2: the model is never told the nickname; if it
    // reaches for one anyway, the validator below catches the placeholder.
    steps: z.array(stepSchema).min(3).max(10),
  }) as unknown as z.ZodType<LessonBlockGenerated>;
}
