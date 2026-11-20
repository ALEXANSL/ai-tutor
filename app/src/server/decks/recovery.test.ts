import { beforeEach, expect, it, vi } from "vitest";
import type { NarratedDeck } from "@/lib/narrated-deck";
const f = vi.hoisted(() => ({ row: vi.fn(), enqueue: vi.fn(), kick: vi.fn(), update: vi.fn() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => {
  const chain = { eq: () => chain, order: () => chain, limit: () => chain, maybeSingle: f.row };
  return { select: () => chain };
} }));
vi.mock("@/server/jobs/runner", () => ({ enqueueJob: f.enqueue }));
vi.mock("./kick", () => ({ kickDeck: f.kick }));
vi.mock("./store", () => ({ WORK_TYPE: "presentation.prepare", updateDeck: f.update }));
import { reconcileDeck } from "./recovery";
const draft: NarratedDeck = { title: "Урок", driveId: "d", subjectId: "s", slides: [{ notes: "", narration: "збережено", ready: false }], state: "processing", published: false, revision: 2, error: "" };
beforeEach(() => {
  vi.clearAllMocks();
  f.update.mockImplementation((_f, _id, deck, patch) => ({ ...deck, ...patch }));
});
it.each([["queued", -1000, true], ["queued", 60000, false], ["running", -1000, true], ["running", 60000, false]])("respects %s job eligibility at offset %i", async (status, offset, wake) => {
  const at = new Date(Date.now() + Number(offset)).toISOString();
  f.row.mockResolvedValue({ data: { status, run_after: at, locked_until: at }, error: null });
  await reconcileDeck("family", "deck", draft);
  expect(f.kick).toHaveBeenCalledTimes(wake ? 1 : 0); expect(f.enqueue).not.toHaveBeenCalled();
});
it("automatically resumes the legacy storage failure once without wiping the script", async () => {
  const failure = { ...draft, state: "error" as const, error: "Не вдалося перевірити збережений аудіофрагмент." };
  f.row.mockResolvedValue({ data: { status: "queued", run_after: new Date(0).toISOString() } });
  const resumed = await reconcileDeck("family", "deck", failure);
  expect(resumed.slides).toEqual(failure.slides); expect(resumed.state).toBe("processing");
  await reconcileDeck("family", "deck", { ...failure, audioLookupRecovered: true });
  expect(f.enqueue).toHaveBeenCalledTimes(1);
});
