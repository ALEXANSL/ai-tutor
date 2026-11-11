import { beforeEach, expect, it, vi } from "vitest";
import { audioId, familyId, narrative, partFixture } from "./__fixtures__/part";
import type { AudioPart } from "@/lib/audiobooks";
const f = vi.hoisted(() => ({ part: null as AudioPart | null, prepare: vi.fn(), narrate: vi.fn(), exists: vi.fn(), upload: vi.fn(), remove: vi.fn() }));
vi.mock("./store", () => ({ readAudioPart: async (family: string) => family === "33333333-3333-4333-8333-333333333333" ? structuredClone(f.part) : null, saveAudioPart: async (_f: string, _id: string, old: AudioPart, changes: Partial<AudioPart>) => { if (f.part?.revision !== old.revision) throw new Error("conflict"); f.part = { ...old, ...changes, revision: old.revision + 1 }; f.part.readyCount = f.part.segments.filter(s => s.ready).length; f.part.segmentCount = f.part.segments.length; return structuredClone(f.part); }, insertAudioPart: vi.fn() }));
vi.mock("./library", () => ({ libraryBook: vi.fn(), physicalRange: vi.fn(), loadAudioSource: vi.fn() }));
vi.mock("./models", () => ({ audioModelConfig: async () => ({ route: { primary_model: "tts-1-hd" } }), audioReservation: () => 0.1, prepareAudioText: f.prepare, narrateAudio: f.narrate }));
vi.mock("./storage", () => ({ audioExists: f.exists, saveAudioBytes: f.upload, deleteAudioBytes: f.remove }));
import { runAudioPart, commandAudioPart } from "./workflow";
beforeEach(() => { vi.clearAllMocks(); f.part = partFixture(); f.prepare.mockResolvedValue({ result: { omitted: [], notes: "Дослівний текст" }, costUsd: 0.01, model: { provider: "openai", model: "gpt-5.4" } }); f.narrate.mockResolvedValue({ result: { audioBase64: "test", mimeType: "audio/mpeg" }, costUsd: 0.02, model: { provider: "openai", model: "tts-1-hd" } }); f.exists.mockResolvedValue(false); });
it("stops at draft until parent approves and only publishes after all segments exist", async () => {
  await runAudioPart(familyId, audioId, f.part!.token); expect(f.part!.state).toBe("draft"); expect(f.narrate).not.toHaveBeenCalled();
  await expect(commandAudioPart(familyId, audioId, f.part!.revision, "publish")).rejects.toThrow();
  await commandAudioPart(familyId, audioId, f.part!.revision, "approve", narrative.repeat(20));
  await runAudioPart(familyId, audioId, f.part!.token); expect(f.part!.state).toBe("ready"); expect(f.part!.segments.length).toBeGreaterThan(1); expect(f.part!.readyCount).toBe(f.part!.segmentCount); expect(f.part!.published).toBe(false);
  await commandAudioPart(familyId, audioId, f.part!.revision, "publish"); expect(f.part!.published).toBe(true);
});
it("concurrent workers issue only one paid request", async () => { await Promise.all([runAudioPart(familyId, audioId, f.part!.token), runAudioPart(familyId, audioId, f.part!.token)]); expect(f.prepare).toHaveBeenCalledTimes(1); });
it("cap stops before payment and uncertain failures preserve reservation without auto retry", async () => {
  f.part = partFixture({ heldUsd: 2.95 }); await runAudioPart(familyId, audioId, f.part.token); expect(f.prepare).not.toHaveBeenCalled(); expect(f.part.state).toBe("failed");
  f.part = partFixture(); f.prepare.mockRejectedValueOnce(new Error("network error")); await runAudioPart(familyId, audioId, f.part.token); expect(f.part.heldUsd).toBe(0.1); const token = f.part.token; await runAudioPart(familyId, audioId, token); expect(f.prepare).toHaveBeenCalledTimes(1);
});
it("stale token/revision and another family cannot run or change a project", async () => {
  await runAudioPart("foreign", audioId, f.part!.token); await runAudioPart(familyId, audioId, "old-token"); expect(f.prepare).not.toHaveBeenCalled(); await expect(commandAudioPart(familyId, audioId, 99, "pause")).rejects.toThrow();
});
it("uses a saved segment after a checkpoint failure instead of paying again", async () => {
  f.part = partFixture({ state: "draft", manuscript: narrative }); await commandAudioPart(familyId, audioId, f.part.revision, "approve"); f.exists.mockResolvedValue(true); await runAudioPart(familyId, audioId, f.part.token); expect(f.narrate).not.toHaveBeenCalled(); expect(f.part.state).toBe("ready");
});
it("pause invalidates the worker and settles its in-flight bill without continuing", async () => {
  let resolve!: (value: unknown) => void; f.prepare.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const run = runAudioPart(familyId, audioId, f.part!.token); await vi.waitFor(() => expect(f.prepare).toHaveBeenCalled());
  await commandAudioPart(familyId, audioId, f.part!.revision, "pause"); expect(f.part!.state).toBe("paused");
  await expect(commandAudioPart(familyId, audioId, f.part!.revision, "resume")).rejects.toThrow("ще завершується");
  resolve({ result: { omitted: [], notes: "" }, costUsd: 0.02, model: { provider: "openai", model: "gpt-5.4" } }); await run;
  expect(f.part!.state).toBe("paused"); expect(f.part!.spentUsd).toBe(0.02); expect(f.part!.heldUsd).toBe(0); expect(f.part!.leaseUntil).toBe(0);
});
it("delete hides first, removes audio and clears retained source/manuscript without touching original", async () => {
  f.part = partFixture({ state: "ready", published: true, manuscript: narrative, segments: [{ key: "key", text: narrative, ready: true }] }); await commandAudioPart(familyId, audioId, f.part.revision, "delete"); expect(f.remove).toHaveBeenCalled(); expect(f.part.state).toBe("deleted"); expect(f.part.paragraphs).toEqual([]); expect(f.part.manuscript).toBe(""); expect(f.part.published).toBe(false);
});
