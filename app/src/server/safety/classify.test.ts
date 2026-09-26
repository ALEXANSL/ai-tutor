import { describe, expect, it } from "vitest";
import { isFlagged, isUrgent, mergeVerdict, needsEscalation, moderationSchema, type ModerationVerdict } from "./classify";

const verdict = (v: Partial<ModerationVerdict>): ModerationVerdict => ({
  category: "none",
  severity: "none",
  confidence: 1,
  reasonUk: "ok",
  ...v,
});

describe("moderationSchema", () => {
  it("accepts a well-formed verdict and rejects an out-of-range confidence", () => {
    expect(moderationSchema.safeParse(verdict({ category: "fear", severity: "normal", confidence: 0.9 })).success).toBe(true);
    expect(moderationSchema.safeParse(verdict({ confidence: 1.5 })).success).toBe(false);
  });
});

describe("needsEscalation (ADR-009 §3)", () => {
  it("escalates when layer 1 flagged but layer 2 saw nothing", () => {
    expect(needsEscalation(true, verdict({ category: "none", confidence: 0.95 }))).toBe(true);
  });
  it("escalates on low layer-2 confidence, even if layer 1 didn't flag anything", () => {
    expect(needsEscalation(false, verdict({ category: "fear", severity: "normal", confidence: 0.4 }))).toBe(true);
  });
  it("does not escalate a confident, layer-1-clean verdict", () => {
    expect(needsEscalation(false, verdict({ category: "fear", severity: "normal", confidence: 0.9 }))).toBe(false);
  });
  it("does not escalate merely because layer 1 flagged something layer 2 also caught", () => {
    expect(needsEscalation(true, verdict({ category: "violence", severity: "urgent", confidence: 0.95 }))).toBe(false);
  });
});

describe("mergeVerdict", () => {
  it("uses layer 2 directly when there is no escalation", () => {
    const v = verdict({ category: "sadness", severity: "normal", confidence: 0.8 });
    expect(mergeVerdict(false, v, null)).toEqual({ ...v, layer1Flagged: false, escalated: false, layersUnavailable: false });
  });
  it("the escalation verdict wins over layer 2's own guess", () => {
    const layer2 = verdict({ category: "none", severity: "none", confidence: 0.3 });
    const escalation = verdict({ category: "self_harm", severity: "urgent", confidence: 0.97 });
    expect(mergeVerdict(true, layer2, escalation)).toEqual({ ...escalation, layer1Flagged: true, escalated: true, layersUnavailable: false });
  });
  it("flags layersUnavailable when the caller reports both layers failed", () => {
    const v = verdict({ category: "none", severity: "none", confidence: 1 });
    expect(mergeVerdict(false, v, null, true)).toEqual({ ...v, layer1Flagged: false, escalated: false, layersUnavailable: true });
  });
});

describe("isUrgent / isFlagged (US-12.1 КП-1/КП-2)", () => {
  it("only severity=urgent is urgent", () => {
    expect(isUrgent({ severity: "urgent" })).toBe(true);
    expect(isUrgent({ severity: "normal" })).toBe(false);
    expect(isUrgent({ severity: "none" })).toBe(false);
  });
  it("category=none is never flagged, even with a stray non-none severity", () => {
    expect(isFlagged({ category: "none", severity: "normal" })).toBe(false);
    expect(isFlagged({ category: "sadness", severity: "normal" })).toBe(true);
    expect(isFlagged({ category: "sadness", severity: "none" })).toBe(false);
  });
});
