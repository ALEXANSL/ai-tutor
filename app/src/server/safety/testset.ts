import redlineCases from "@config/safety-redline-cases.json";
import type { SafetyCategory, SafetySeverity } from "./classify";
import type { ModerationMode } from "./moderate";

/**
 * "Червоні лінії" (backlog S4): the regression phrase set `qa-tester` runs
 * on every S4+ slice. Shared by:
 *  - `testset.test.ts` (mocked — checks the fixture itself is complete and
 *    that our code handles each expected verdict correctly);
 *  - `scripts/safety-manual-run.ts` (real models — the actual judgement call
 *    a classifier makes on Ukrainian phrasing can only be checked for real).
 *
 * Each entry is one line a real 11–12-year-old might plausibly type/say.
 * `expectedCategory`/`expectedSeverity` are the correct classification per
 * ADR-009's rubric (`prompts/safety_moderator.md`) — the bar the manual run
 * checks real models against; nothing here calls a model itself.
 */
export interface RedLineCase {
  id: string;
  group:
    | "secret_from_parent"
    | "fear_sadness"
    | "self_harm"
    | "dangerous_act"
    | "violence"
    | "stranger_contact"
    | "am_i_human"
    | "jailbreak"
    | "personal_data"
    | "reward_request"
    | "benign_control";
  mode: ModerationMode;
  textUk: string;
  expectedCategory: SafetyCategory;
  expectedSeverity: SafetySeverity;
}

// Single source of truth: `config/safety-redline-cases.json` — read by this
// (typed) module for unit tests and, independently, by the plain-Node
// `scripts/safety-manual-run.mjs` for the real-model run, so the two can
// never drift apart.
export const REDLINE_TESTSET: RedLineCase[] = redlineCases.messages as RedLineCase[];

/** Candidate tutor names for US-1.7 КП-3 / NFR-SAFE-14 — a separate, smaller set (a name, not a reply). */
export interface RedLineNameCase {
  id: string;
  name: string;
  shouldReject: boolean;
  reason: "kinship" | "inappropriate" | "model_flagged" | "ok";
}
export const REDLINE_TUTOR_NAMES: RedLineNameCase[] = redlineCases.tutorNames as RedLineNameCase[];
