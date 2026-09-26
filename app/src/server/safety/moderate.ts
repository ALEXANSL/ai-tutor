import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callStructured } from "@/server/ai/router";
import { openaiModerate } from "@/server/ai/providers/openai";
import { fillTemplate, splitPrompt } from "@/server/ingest/structure";
import { mergeVerdict, moderationSchema, needsEscalation, type ModerationResult } from "./classify";

/**
 * Two-layer moderator (ADR-009): every child reply (lesson open answers,
 * topic chat, "ШІ-друг", and a candidate tutor name — US-1.7 КП-3) goes
 * through this. Runs in parallel with the tutor's own reply (never adds to
 * its latency, ADR-009 §4) and NEVER throws: any provider failure degrades
 * to "not flagged" for that layer rather than blocking the child (NFR-SAFE-13
 * is about never SKIPPING moderation for budget reasons; a genuine outage of
 * every provider in the chain is the one case where we fail open rather than
 * freeze the product — logged so it is visible, never silent).
 */
let promptCache: { system: string; user: string } | null = null;
function moderatorPrompt(): { system: string; user: string } {
  promptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "safety_moderator.md"), "utf8"));
  return promptCache;
}

export type ModerationMode = "lesson" | "tutor_chat" | "friend_chat" | "voice" | "tutor_name";

export interface ModerateInput {
  familyId: string;
  sessionId?: string;
  mode: ModerationMode;
  message: string;
  /** Last 2-3 replies, oldest first (ADR-009 §2) — plain text, no author labels needed. */
  context?: string[];
}

async function classify(input: ModerateInput, escalate: boolean) {
  const { system, user } = moderatorPrompt();
  const prompt = fillTemplate(user, {
    mode: input.mode,
    context: (input.context ?? []).join("\n") || "(немає)",
    message: input.message,
  });
  const res = await callStructured(
    "safety_moderator",
    { system, prompt, schema: moderationSchema },
    { familyId: input.familyId, sessionId: input.sessionId, escalate },
  );
  return res.result;
}

/**
 * US-1.7 КП-3: a candidate tutor name that passed the dictionary check
 * (`validateTutorName`) still goes through the model (layer 2 only — a name
 * is not a moderation-endpoint kind of text, ADR-009 §2 table). Returns
 * `true` only when it should be rejected (`inappropriate_name`, any
 * confidence — no escalation needed for a five-word input).
 */
export async function moderateTutorName(familyId: string, name: string): Promise<boolean> {
  const result = await classify({ familyId, mode: "tutor_name", message: name }, false);
  return result.category === "inappropriate_name" && result.severity !== "none";
}

export async function moderateMessage(input: ModerateInput): Promise<ModerationResult> {
  let layer1Failed = false;
  let layer2Failed = false;
  const [layer1, layer2] = await Promise.all([
    openaiModerate(input.message).catch((e: Error) => {
      console.error(`safety layer 1 (omni-moderation) failed: ${e.message}`);
      layer1Failed = true;
      return { flagged: false, categories: [] };
    }),
    classify(input, false).catch((e: Error) => {
      console.error(`safety layer 2 (safety_moderator) failed: ${e.message}`);
      layer2Failed = true;
      return { category: "none" as const, severity: "none" as const, confidence: 1, reasonUk: "" };
    }),
  ]);
  // QA residual-risk finding: when BOTH layers failed for this one message,
  // the "none" verdict below is a synthetic fail-open default, not a real
  // safety judgement — `layersUnavailable` lets `recordSafetyEvent` still
  // tell the parent to check the conversation manually, even though nothing
  // was technically "flagged" (see classify.ts doc comment, ADR-009).
  const layersUnavailable = layer1Failed && layer2Failed;

  if (!needsEscalation(layer1.flagged, layer2)) {
    return mergeVerdict(layer1.flagged, layer2, null, layersUnavailable);
  }
  try {
    const escalation = await classify(input, true);
    return mergeVerdict(layer1.flagged, layer2, escalation, layersUnavailable);
  } catch (e) {
    console.error(`safety escalation failed: ${(e as Error).message}`);
    return mergeVerdict(layer1.flagged, layer2, null, layersUnavailable);
  }
}
