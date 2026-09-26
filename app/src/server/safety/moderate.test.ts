import { describe, expect, it, vi } from "vitest";

/**
 * `moderateMessage`/`moderateTutorName` with mocked providers — never a real
 * OpenAI/Anthropic call (same convention as `lessons/pipeline.test.ts`).
 * Covers ADR-009's chain end-to-end: layer 1 + layer 2 -> merge -> optional
 * escalation, and that every layer failing open never throws into the
 * caller (a moderator outage must never crash the child's reply, ADR-009).
 */
const callStructured = vi.fn();
vi.mock("@/server/ai/router", () => ({ callStructured: (...args: unknown[]) => callStructured(...args) }));
const openaiModerate = vi.fn();
vi.mock("@/server/ai/providers/openai", () => ({ openaiModerate: (...args: unknown[]) => openaiModerate(...args) }));

const { moderateMessage, moderateTutorName } = await import("./moderate");

function structuredResult(verdict: Record<string, unknown>) {
  return { result: verdict, model: { provider: "anthropic", model: "claude-haiku-4-5" }, costUsd: 0.0001, fallbackUsed: false };
}

describe("moderateMessage", () => {
  it("a clean message: no escalation, severity none", async () => {
    openaiModerate.mockResolvedValueOnce({ flagged: false, categories: [] });
    callStructured.mockResolvedValueOnce(structuredResult({ category: "none", severity: "none", confidence: 0.97, reasonUk: "ok" }));
    const r = await moderateMessage({ familyId: "f1", mode: "lesson", message: "як розв'язати 2+2?" });
    expect(r).toMatchObject({ category: "none", severity: "none", escalated: false, layer1Flagged: false });
    expect(callStructured).toHaveBeenCalledTimes(1);
  });

  it("urgent self-harm: layer 2 confident -> no escalation call, severity stays urgent", async () => {
    openaiModerate.mockResolvedValueOnce({ flagged: true, categories: ["self-harm"] });
    callStructured.mockResolvedValueOnce(structuredResult({ category: "self_harm", severity: "urgent", confidence: 0.95, reasonUk: "загроза" }));
    const r = await moderateMessage({ familyId: "f1", mode: "friend_chat", message: "я хочу собі зашкодити" });
    expect(r).toMatchObject({ category: "self_harm", severity: "urgent", escalated: false, layer1Flagged: true });
    expect(callStructured).toHaveBeenCalledTimes(1);
  });

  it("low confidence -> escalates to Sonnet 5 (ctx.escalate=true), and the escalation's verdict wins", async () => {
    openaiModerate.mockResolvedValueOnce({ flagged: false, categories: [] });
    callStructured
      .mockResolvedValueOnce(structuredResult({ category: "fear", severity: "normal", confidence: 0.3, reasonUk: "не впевнена" }))
      .mockResolvedValueOnce(structuredResult({ category: "none", severity: "none", confidence: 0.9, reasonUk: "хибне спрацювання" }));
    const r = await moderateMessage({ familyId: "f1", mode: "tutor_chat", message: "мені трохи страшно перед контрольною" });
    expect(r).toMatchObject({ category: "none", severity: "none", escalated: true });
    expect(callStructured).toHaveBeenCalledTimes(2);
    const [, , escalationCtx] = callStructured.mock.calls[1]!;
    expect(escalationCtx).toMatchObject({ escalate: true });
  });

  it("layer 1 flags it but layer 2 sees nothing -> escalates", async () => {
    openaiModerate.mockResolvedValueOnce({ flagged: true, categories: ["violence"] });
    callStructured
      .mockResolvedValueOnce(structuredResult({ category: "none", severity: "none", confidence: 0.9, reasonUk: "не побачив" }))
      .mockResolvedValueOnce(structuredResult({ category: "violence", severity: "normal", confidence: 0.85, reasonUk: "таки є" }));
    const r = await moderateMessage({ familyId: "f1", mode: "lesson", message: "..." });
    expect(r).toMatchObject({ category: "violence", severity: "normal", escalated: true });
  });

  it("layer 1 (omni-moderation) down -> degrades to 'not flagged' for that layer, layer 2 still runs", async () => {
    openaiModerate.mockRejectedValueOnce(new Error("openai down"));
    callStructured.mockResolvedValueOnce(structuredResult({ category: "sadness", severity: "normal", confidence: 0.9, reasonUk: "сумно" }));
    const r = await moderateMessage({ familyId: "f1", mode: "lesson", message: "мені сумно" });
    expect(r).toMatchObject({ category: "sadness", severity: "normal", layer1Flagged: false });
  });

  it("layer 2 (safety_moderator) down -> degrades to 'none' rather than throwing (NFR-SAFE-13: never blocks the reply)", async () => {
    openaiModerate.mockResolvedValueOnce({ flagged: false, categories: [] });
    callStructured.mockRejectedValueOnce(new Error("anthropic down"));
    await expect(moderateMessage({ familyId: "f1", mode: "lesson", message: "будь-що" })).resolves.toMatchObject({ category: "none", severity: "none" });
  });

  it("both layers unavailable at once (no API keys) -> fails open to 'none' without throwing, escalation is skipped (not attempted uselessly), and layersUnavailable is set", async () => {
    openaiModerate.mockRejectedValueOnce(new Error("openai down"));
    callStructured.mockRejectedValueOnce(new Error("anthropic down"));
    await expect(
      moderateMessage({ familyId: "f1", mode: "friend_chat", message: "я хочу собі зашкодити" }),
    ).resolves.toMatchObject({ category: "none", severity: "none", layer1Flagged: false, escalated: false, layersUnavailable: true });
    // Only the initial (non-escalated) layer-2 attempt runs — a confident-looking
    // synthetic "none" (confidence: 1 from the catch handler) does not trigger a
    // second, equally doomed call: documented trade-off (ADR-009 §4/moderate.ts
    // comment) — a genuine full-outage silently lets an unsafe message through
    // rather than blocking the child's lesson/chat. `recordSafetyEvent` is never
    // reached in this case (severity "none" is not `isFlagged`), but the
    // `layersUnavailable` flag it carries is what lets `recordSafetyEvent` still
    // alert the parent separately (`events.test.ts` — residual-risk fix) even
    // though nothing was technically "flagged".
    expect(callStructured).toHaveBeenCalledTimes(1);
  });

  it("only ONE layer down -> layersUnavailable stays false (a single provider outage is not the residual-risk case)", async () => {
    openaiModerate.mockRejectedValueOnce(new Error("openai down"));
    callStructured.mockResolvedValueOnce(structuredResult({ category: "sadness", severity: "normal", confidence: 0.9, reasonUk: "сумно" }));
    const r = await moderateMessage({ familyId: "f1", mode: "lesson", message: "мені сумно" });
    expect(r.layersUnavailable).toBe(false);
  });

  it("escalation itself fails -> falls back to layer 2's own verdict, never throws", async () => {
    openaiModerate.mockResolvedValueOnce({ flagged: true, categories: ["x"] });
    callStructured
      .mockResolvedValueOnce(structuredResult({ category: "none", severity: "none", confidence: 0.9, reasonUk: "?" }))
      .mockRejectedValueOnce(new Error("escalation down"));
    const r = await moderateMessage({ familyId: "f1", mode: "lesson", message: "..." });
    expect(r).toMatchObject({ category: "none", severity: "none", escalated: false });
  });
});

describe("moderateTutorName (US-1.7 КП-3: a model layer beyond the wordlist)", () => {
  it("flags a name the classifier calls inappropriate_name", async () => {
    callStructured.mockResolvedValueOnce(structuredResult({ category: "inappropriate_name", severity: "normal", confidence: 0.9, reasonUk: "видає за родича" }));
    await expect(moderateTutorName("f1", "Дідусь")).resolves.toBe(true);
  });
  it("does not flag an ordinary name", async () => {
    callStructured.mockResolvedValueOnce(structuredResult({ category: "none", severity: "none", confidence: 0.95, reasonUk: "ok" }));
    await expect(moderateTutorName("f1", "Ліра")).resolves.toBe(false);
  });
  it("a provider failure never blocks saving the name (caller treats a throw as \"not flagged\")", async () => {
    callStructured.mockRejectedValueOnce(new Error("down"));
    await expect(moderateTutorName("f1", "Ліра")).rejects.toThrow();
  });
});
