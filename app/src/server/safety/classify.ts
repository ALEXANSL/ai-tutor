import { z } from "zod";

/**
 * Pure decision rules for the two-layer moderator (ADR-009). No I/O here —
 * `moderate.ts` wires these to the OpenAI omni-moderation endpoint and the
 * `safety_moderator` role; this file is unit-tested directly with plain
 * layer results.
 */
export const SAFETY_CATEGORIES = [
  "none",
  "fear",
  "sadness",
  "self_harm",
  "dangerous_act",
  "violence",
  "stranger_contact",
  "secret_from_parent",
  "personal_data",
  "reward_request",
  "jailbreak",
  "inappropriate_name",
  "other",
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];
export type SafetySeverity = "none" | "normal" | "urgent";

export const moderationSchema = z.object({
  category: z.enum(SAFETY_CATEGORIES),
  severity: z.enum(["none", "normal", "urgent"]),
  confidence: z.number().min(0).max(1),
  reasonUk: z.string().min(1).max(200),
});
export type ModerationVerdict = z.infer<typeof moderationSchema>;

/** Low-confidence threshold that triggers escalation (docs/02 6.2: < 0.6, same bar as US-13.3). */
export const ESCALATION_CONFIDENCE_THRESHOLD = 0.6;

/**
 * ADR-009 step 3: layer 1 (omni-moderation) flagged the message, OR layer 2
 * is not confident enough -> Sonnet 5 decides for good.
 */
export function needsEscalation(layer1Flagged: boolean, layer2: ModerationVerdict): boolean {
  if (layer1Flagged && layer2.category === "none") return true;
  return layer2.confidence < ESCALATION_CONFIDENCE_THRESHOLD;
}

export interface ModerationResult {
  category: SafetyCategory;
  severity: SafetySeverity;
  confidence: number;
  reasonUk: string;
  layer1Flagged: boolean;
  escalated: boolean;
}

/** Combines layer 1 + layer 2 (+ an optional escalation verdict) into the final call. */
export function mergeVerdict(
  layer1Flagged: boolean,
  layer2: ModerationVerdict,
  escalation: ModerationVerdict | null,
): ModerationResult {
  const escalated = escalation != null;
  const final = escalation ?? layer2;
  return { ...final, layer1Flagged, escalated };
}

/** US-12.1 КП-1/КП-2: only `urgent` triggers "go to dad now" + external channels. */
export function isUrgent(result: Pick<ModerationResult, "severity">): boolean {
  return result.severity === "urgent";
}

/** Any flagged category is worth a cabinet notification (US-11.6 КП-1); `none` is not. */
export function isFlagged(result: Pick<ModerationResult, "category" | "severity">): boolean {
  return result.category !== "none" && result.severity !== "none";
}
