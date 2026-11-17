import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ auth: vi.fn(), kick: vi.fn(), owned: true, families: [] as string[], filters: [] as unknown[], projects: [] as unknown[], steps: [] as unknown[], events: [] as unknown[] }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.auth }));
vi.mock("@/server/studio/wake", () => ({ kickStudio: f.kick }));
vi.mock("@/server/studio/store", () => ({ STUDIO_PROJECT: "studio.project", STUDIO_STEP: "studio.step" }));
vi.mock("@/server/studio/review-history", () => ({ STUDIO_REVIEW_EVENT: "studio.review_event" }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => { f.families.push(family); return { select: () => {
  let type = ""; const q = { eq: (key: string, value: unknown) => { if (key === "type") type = String(value); f.filters.push([key, value]); return q; }, in: () => q, lte: () => q, limit: () => q, order: () => q, range: (from: number, to: number) => { f.filters.push(["range", from, to]); return q; }, maybeSingle: async () => ({ data: f.owned ? { id: "owned" } : null }), returns: async () => ({ data: type === "studio.project" ? f.projects : type === "studio.step" ? f.steps : f.events, error: null }) }; return q;
} }; } }));
import { wakeStudioWorkspaceAction, studioReviewHistoryAction } from "./studio-activity";
const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
beforeEach(() => { vi.clearAllMocks(); f.owned = true; f.families = []; f.filters = []; f.projects = []; f.steps = []; f.events = []; f.auth.mockResolvedValue({ familyId: "own-family" }); });
it("requires parent access before waking or reading any jobs", async () => {
  f.auth.mockRejectedValue(new Error("parent only")); await expect(wakeStudioWorkspaceAction()).rejects.toThrow("parent only"); await expect(studioReviewHistoryAction(first)).rejects.toThrow("parent only"); expect(f.families).toEqual([]); expect(f.kick).not.toHaveBeenCalled();
});
it("wakes independent queued projects once each and recovers legacy review gates but respects an explicit automation stop", async () => {
  f.steps = [{ payload: { projectId: first } }, { payload: { projectId: first } }]; f.projects = [{ id: first, state: "generating", stopped: null }, { id: second, state: "needs_changes", stopped: null }, { id: "33333333-3333-4333-8333-333333333333", state: "needs_changes", stopped: "true" }];
  expect((await wakeStudioWorkspaceAction()).active).toBe(2); expect(f.kick.mock.calls).toEqual([["own-family", first], ["own-family", second]]); expect(f.families.every(family => family === "own-family")).toBe(true);
});
it("refuses another project's review history before querying its events", async () => {
  f.owned = false; await expect(studioReviewHistoryAction(first)).rejects.toThrow("недоступний"); expect(f.filters).not.toContainEqual(["type", "studio.review_event"]);
});
it("returns only a bounded history page scoped to the selected owned project", async () => {
  f.events = Array.from({ length: 11 }, (_, round) => ({ payload: { event: { round, review: { summary: `Рецензія ${round}` } } } }));
  const result = await studioReviewHistoryAction(first, 2); expect(result.events).toHaveLength(10); expect(result.hasMore).toBe(true); expect(f.filters).toContainEqual(["payload->>projectId", first]); expect(f.filters).toContainEqual(["range", 20, 30]);
});
