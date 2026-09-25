import "server-only";
import { getLessonComponent } from "@/lesson-components";

/**
 * Server-side gate the model's output must pass before a step is ever shown
 * (NFR-SAFE-15, ADR-020 §3): unknown component, schema mismatch, unsafe text
 * (script tags, markup, links) or a semantically broken answer all fall back
 * to a plain "choice"/"open" step instead of blocking the lesson.
 */
export interface RawComponentRef {
  component: string;
  v?: number;
  props?: unknown;
  fallback_text?: string;
}

export type ComponentValidation =
  | { ok: true; component: string; v: number; props: unknown }
  | { ok: false; reason: string; fallback: { type: "choice" | "open"; content: Record<string, unknown> } };

/** Blocks the exact things NFR-SAFE-15 names: script/HTML markup, URLs. */
const UNSAFE_TEXT_PATTERN = /<\s*script|<[a-z][\s\S]*>|javascript:|https?:\/\/|www\./i;

/** Every string leaf of `props` must be plain text (ADR-020 §1, §3c). */
function findUnsafeString(value: unknown): string | null {
  if (typeof value === "string") return UNSAFE_TEXT_PATTERN.test(value) ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      const bad = findUnsafeString(v);
      if (bad) return bad;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const bad = findUnsafeString(v);
      if (bad) return bad;
    }
  }
  return null;
}

const DEFAULT_FALLBACK_TEXT = "Обери правильну відповідь.";

function fallbackStep(reason: string, rawFallbackText: string | undefined): ComponentValidation {
  console.warn(`[lesson-components] step replaced with a plain exercise: ${reason}`);
  return {
    ok: false,
    reason,
    fallback: { type: "open", content: { questionUk: (rawFallbackText || DEFAULT_FALLBACK_TEXT).slice(0, 300) } },
  };
}

/**
 * Validates one model-generated interactive/visual component reference.
 * Never throws: an invalid description degrades to a safe fallback step
 * (US-6.8 КП-1) and the caller logs the event for `qa-tester`.
 */
export function validateComponentRef(ref: unknown): ComponentValidation {
  if (!ref || typeof ref !== "object") return fallbackStep("missing component ref", undefined);
  const raw = ref as RawComponentRef;
  if (typeof raw.component !== "string") return fallbackStep("missing component key", raw.fallback_text);

  const def = getLessonComponent(raw.component);
  if (!def) return fallbackStep(`unknown component "${raw.component}"`, raw.fallback_text);

  const unsafeInFallback = raw.fallback_text ? findUnsafeString(raw.fallback_text) : null;
  if (unsafeInFallback) return fallbackStep(`unsafe fallback_text for "${raw.component}"`, undefined);

  const parsed = def.propsSchema.safeParse(raw.props);
  if (!parsed.success) {
    return fallbackStep(`schema mismatch for "${raw.component}": ${parsed.error.issues[0]?.message ?? "invalid"}`, raw.fallback_text);
  }

  const unsafe = findUnsafeString(parsed.data);
  if (unsafe) return fallbackStep(`unsafe text in "${raw.component}" props: "${unsafe.slice(0, 60)}"`, raw.fallback_text);

  const semanticError = def.validateSemantics(parsed.data as never);
  if (semanticError) return fallbackStep(`semantic error in "${raw.component}": ${semanticError}`, raw.fallback_text);

  return { ok: true, component: raw.component, v: def.v, props: parsed.data };
}
