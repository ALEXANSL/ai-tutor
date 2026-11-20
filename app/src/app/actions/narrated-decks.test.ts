import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn(), options: vi.fn(), enqueue: vi.fn(), kick: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: async () => ({ familyId: "family" }) }));
vi.mock("@/server/decks/store", () => ({ getDeck: f.get, updateDeck: f.update }));
vi.mock("@/server/decks/placement", () => ({ deckLessonOptions: f.options }));
vi.mock("@/server/jobs/runner", () => ({ enqueueJob: f.enqueue }));
vi.mock("@/server/decks/kick", () => ({ kickDeck: f.kick }));
import { changeDeckPlacement } from "./narrated-decks";
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
