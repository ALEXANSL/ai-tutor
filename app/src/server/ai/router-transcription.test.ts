import { describe, expect, it, vi } from "vitest";
import { transcribeAudio, type RouterDeps } from "./router";
import { AiNotConfiguredError, BudgetBlockedError, ProviderError, type BudgetState, type ModelRoute } from "./types";

const file = new File([new Uint8Array([1, 2, 3])], "utterance.webm", { type: "audio/webm" });
function dependencies(state: BudgetState = "normal", duration = 13) {
  const route: ModelRoute = {
    role: "voice_transcription", primary_provider: "openai", primary_model: "whisper-1",
    fallback_provider: null, fallback_model: null, escalation_provider: null, escalation_model: null,
    economy_provider: null, economy_model: null, params: { budget_policy: "defer", timeout_ms: 30_000 },
  };
  const transcription = vi.fn().mockResolvedValue({ data: "Поясни ще раз", usage: { inputTokens: duration, outputTokens: 0 } });
  const recordCall = vi.fn().mockResolvedValue(undefined);
  let time = 0;
  const deps: RouterDeps = {
    loadRoute: vi.fn().mockResolvedValue(route),
    getBudgetState: vi.fn().mockResolvedValue(state),
    loadPrice: vi.fn().mockResolvedValue({ input_usd_per_mtok: 100, output_usd_per_mtok: 0, cache_read_usd_per_mtok: null, cache_write_usd_per_mtok: null }),
    recordCall, notifyFallback: vi.fn().mockResolvedValue(undefined),
    providers: { structured: {}, embed: {}, vision: {}, audio: {}, transcription: { openai: transcription } },
    now: () => (time += 10),
  };
  return { deps, transcription, recordCall };
}

describe("routed speech transcription", () => {
  it("records authoritative audio seconds at $0.006/min through the normal accounting path", async () => {
    const { deps, transcription, recordCall } = dependencies();
    const result = await transcribeAudio(file, { familyId: "family", ref: { table: "voice_sessions", id: "lease" } }, deps);
    expect(deps.loadRoute).toHaveBeenCalledWith("family", "voice_transcription");
    expect(transcription).toHaveBeenCalledWith({ model: "whisper-1", audio: file, params: { budget_policy: "defer", timeout_ms: 30_000 } });
    expect(result).toMatchObject({ result: "Поясни ще раз", audioSeconds: 13, costUsd: 0.0013, fallbackUsed: false });
    expect(recordCall).toHaveBeenCalledWith("family", expect.objectContaining({ role: "voice_transcription", provider: "openai", model: "whisper-1", status: "ok", input_tokens: 13, output_tokens: 0, cost_usd: 0.0013, ref_table: "voice_sessions", ref_id: "lease" }));
  });

  it("accounts for long uploaded audio before the caller rejects its duration", async () => {
    const { deps, recordCall } = dependencies("normal", 180);
    const result = await transcribeAudio(file, { familyId: "family" }, deps);
    expect(result.audioSeconds).toBe(180);
    expect(recordCall).toHaveBeenCalledWith("family", expect.objectContaining({ input_tokens: 180, cost_usd: 0.018, status: "ok" }));
  });

  it.each(["budget", "hard_stop"] as const)("blocks new voice in %s state before contacting the provider", async (state) => {
    const { deps, transcription, recordCall } = dependencies(state);
    await expect(transcribeAudio(file, { familyId: "family" }, deps)).rejects.toBeInstanceOf(BudgetBlockedError);
    expect(transcription).not.toHaveBeenCalled(); expect(recordCall).not.toHaveBeenCalled();
  });

  it("allows a lesson admitted before budget mode to finish, but still enforces hard stop", async () => {
    const admitted = dependencies("budget");
    await expect(transcribeAudio(file, { familyId: "family", sessionStartedBeforeBudget: true }, admitted.deps)).resolves.toMatchObject({ audioSeconds: 13 });
    const stopped = dependencies("hard_stop");
    await expect(transcribeAudio(file, { familyId: "family", sessionStartedBeforeBudget: true }, stopped.deps)).rejects.toBeInstanceOf(BudgetBlockedError);
    expect(stopped.transcription).not.toHaveBeenCalled();
  });

  it("records a failed provider call without inventing a transcript", async () => {
    const { deps, transcription, recordCall } = dependencies();
    transcription.mockRejectedValue(new ProviderError("provider unavailable", "openai", 503, true));
    await expect(transcribeAudio(file, { familyId: "family" }, deps)).rejects.toBeInstanceOf(ProviderError);
    expect(recordCall).toHaveBeenCalledWith("family", expect.objectContaining({ role: "voice_transcription", status: "error", input_tokens: 0 }));
  });

  it("reports an absent transcription adapter as configuration, never a TypeError", async () => {
    const { deps, recordCall } = dependencies();
    delete deps.providers.transcription;
    await expect(transcribeAudio(file, { familyId: "family" }, deps)).rejects.toBeInstanceOf(AiNotConfiguredError);
    expect(recordCall).not.toHaveBeenCalled();
  });
});
