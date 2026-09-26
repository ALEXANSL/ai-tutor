import type { z } from "zod";

/**
 * Interactive lesson component registry (ADR-020, NFR-SAFE-15). The model
 * only ever fills in `props` for a component key from this registry; the
 * component's own code (validation, rendering, grading) is ours, reviewed
 * and tested — never generated. A new component = a new folder here +
 * registration, nothing else in the orchestrator or generator changes.
 */
export interface LessonComponentVerdict {
  correct: boolean;
  /** Per-target/slot detail for partial visual feedback (drag_sort slots, number_line ticks). */
  detail?: Record<string, boolean>;
}

export interface LessonComponentDefinition<P = unknown, A = unknown> {
  /** Registry key, e.g. "drag_sort" — this is what the model returns in `component`. */
  key: string;
  /** Schema version the generator targets; `upgrade` migrates older saved steps. */
  v: number;
  /** Validates and narrows the model's `props` (ADR-020 §1: data only, never markup/HTML/URLs). */
  propsSchema: z.ZodType<P>;
  /**
   * Semantic checks beyond the shape (ADR-020 §3b): e.g. a reachable correct
   * answer, no duplicate targets, denominators in range. Returns an error
   * message, or null if the props are semantically sound.
   */
  validateSemantics(props: P): string | null;
  /** Deterministic grading on the device, no AI call (US-16.2 KP-1, ADR-020 §1). */
  evaluate(props: P, answer: A): LessonComponentVerdict;
  /** Short text for the voice agent / technical log, never raw JSON (ADR-020 §2). */
  describe(props: P, verdict?: LessonComponentVerdict): string;
  /** 5–10 lines fed to the `lesson_generation` prompt: when to use it, limits, example. */
  promptDoc: string;
  /** Plain choice/text step shown instead, if generation or validation fails (US-6.8 KP-1). */
  fallback(props: P | null, fallbackText: string): { type: "choice" | "open"; content: Record<string, unknown> };
}

const registry = new Map<string, LessonComponentDefinition<never, never>>();

export function registerLessonComponent<P, A>(def: LessonComponentDefinition<P, A>): void {
  if (registry.has(def.key)) throw new Error(`[lessonComponents] duplicate key "${def.key}"`);
  registry.set(def.key, def as unknown as LessonComponentDefinition<never, never>);
}

export function getLessonComponent(key: string): LessonComponentDefinition<never, never> | undefined {
  return registry.get(key);
}

export function listLessonComponents(): LessonComponentDefinition<never, never>[] {
  return Array.from(registry.values());
}

/** Components a subject allows (`subjects.config.allowed_components`, ADR-020 §2). */
export function allowedForSubject(allowedKeys: string[] | undefined): LessonComponentDefinition<never, never>[] {
  if (!allowedKeys || allowedKeys.length === 0) return [];
  return allowedKeys.map((k) => registry.get(k)).filter((d): d is LessonComponentDefinition<never, never> => !!d);
}
