import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), options: vi.fn(), enqueue: vi.fn(), kick: vi.fn(), remove: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: async () => ({ familyId: "family" }) }));
vi.mock("@/server/decks/store", () => ({ getDeck: f.get, updateDeck: f.update }));
vi.mock("@/server/decks/placement", () => ({ deckLessonOptions: f.options }));
vi.mock("@/server/jobs/runner", () => ({ enqueueJob: f.enqueue }));
vi.mock("@/server/decks/kick", () => ({ kickDeck: f.kick }));
vi.mock("@/server/decks/lesson-deck", () => ({ scheduleDeck: f.enqueue, queueLessonDeck: vi.fn() }));
vi.mock("@/server/audiobooks/storage", () => ({ deleteAudioBytes: f.remove }));
import { changeDeckPlacement, revoiceDeck } from "./narrated-decks";
import { audioHash } from "@/server/audiobooks/text";
const topicId = "ac38b57c-34ed-4b4b-8d6b-4ac1623925f9";
const deck = { state: "ready", published: true, subjectId: "subject" };
beforeEach(() => { vi.clearAllMocks(); f.get.mockResolvedValue(deck); });
it("attaches an existing published deck and detaches it without regenerating audio", async () => {
  f.options.mockResolvedValue([{ id: topicId }]);
  const form = new FormData();
  for (const choice of [topicId, ""]) {
    form.set("topicId", choice);
    await changeDeckPlacement("deck", form);
    expect(f.update).toHaveBeenLastCalledWith("family", "deck", deck, { topicId: choice || null });
  }
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.kick).not.toHaveBeenCalled();
});
it("rejects a lesson outside the selected subject", async () => {
  f.options.mockResolvedValue([]);
  const form = new FormData(); form.set("topicId", topicId);
  await expect(changeDeckPlacement("deck", form)).rejects.toThrow("недоступний");
  expect(f.options).toHaveBeenCalledWith("family", "subject"); expect(f.update).not.toHaveBeenCalled();
});
it("re-voices a ready deck: drops its saved voice files and requeues every slide", async () => {
  const id = "c65c9460-8e88-497a-a6a5-c3e036cc3e17";
  const ready = { ...deck, slides: [{ notes: "", narration: "Перший", ready: true }, { notes: "", narration: "Другий", ready: true }], video: { state: "ready" } };
  f.get.mockResolvedValue(ready);
  await revoiceDeck(id);
  expect(f.remove).toHaveBeenCalledWith("family", id, [audioHash("Перший"), audioHash("Другий")]);
  expect(f.update).toHaveBeenCalledWith("family", id, ready, expect.objectContaining({ state: "processing", video: null, slides: ready.slides.map(s => ({ ...s, ready: false })) }));
});
it("refuses to re-voice a deck that is still being prepared", async () => {
  f.get.mockResolvedValue({ ...deck, state: "processing", slides: [] });
  await expect(revoiceDeck("c65c9460-8e88-497a-a6a5-c3e036cc3e17")).rejects.toThrow("готову");
  expect(f.remove).not.toHaveBeenCalled();
});
