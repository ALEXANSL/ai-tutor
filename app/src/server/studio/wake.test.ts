import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ after: [] as (() => Promise<void>)[], queue: vi.fn(), fetch: vi.fn(), before: vi.fn() }));
vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => f.after.push(task) }));
vi.mock("./workflow", () => ({ resumeLegacyStudioReview: f.before, runStudioQueue: f.queue }));
vi.mock("./wake-auth", () => ({ studioContinuationUrl: () => "https://fixture.vercel.app/api/studio/continue", signStudioWake: (body: unknown) => ({ signed: body }) }));
import { dispatchStudioContinuation } from "./wake";
beforeEach(() => { vi.clearAllMocks(); f.after = []; vi.stubGlobal("fetch", f.fetch); });
afterEach(() => vi.unstubAllGlobals());
it("uses only a lightweight signed handoff from an exhausted generic worker, not a long queue in its after callback", async () => {
  f.fetch.mockResolvedValue(new Response(null, { status: 202 })); dispatchStudioContinuation("family-a", "project-a", "token-a");
  expect(f.fetch).not.toHaveBeenCalled(); await f.after[0]!();
  expect(f.fetch).toHaveBeenCalledOnce(); expect(f.queue).not.toHaveBeenCalled(); expect(f.before).not.toHaveBeenCalled();
  expect(JSON.parse(f.fetch.mock.calls[0]![1].body)).toMatchObject({ signed: { familyId: "family-a", projectId: "project-a", token: "token-a" } });
});
it("dispatches two projects separately without a shared selected-project slot", async () => {
  f.fetch.mockResolvedValue(new Response(null, { status: 202 })); dispatchStudioContinuation("family", "project-a", "token-a"); dispatchStudioContinuation("family", "project-b", "token-b"); await Promise.all(f.after.map(task => task()));
  expect(f.fetch.mock.calls.map(call => JSON.parse(call[1].body).signed.projectId).sort()).toEqual(["project-a", "project-b"]); expect(f.queue).not.toHaveBeenCalled();
});
