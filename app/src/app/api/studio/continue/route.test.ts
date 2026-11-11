import { beforeEach, expect, it, vi } from "vitest";
import { studioProjectFixture } from "@/server/studio/__fixtures__/project";
const f = vi.hoisted(() => ({ read: vi.fn(), kick: vi.fn() }));
vi.mock("@/server/env", () => ({ requireServiceRoleKey: () => "test-continuation-key" }));
vi.mock("@/server/studio/store", () => ({ readStudioProject: f.read }));
vi.mock("@/server/studio/wake", () => ({ kickStudio: f.kick }));
import { signStudioWake } from "@/server/studio/wake-auth";
import { POST } from "./route";
const familyId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222";
const request = (body: unknown) => new Request("http://localhost/api/studio/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => { vi.clearAllMocks(); f.read.mockResolvedValue(studioProjectFixture()); });
it("does not read drafts or run work for unsigned, malformed or stale requests", async () => {
  expect((await POST(request({ projectId }))).status).toBe(401);
  expect((await POST(request(signStudioWake({ familyId, projectId, token: studioProjectFixture().token, at: Date.now() - 70000 })))).status).toBe(401);
  expect(f.read).not.toHaveBeenCalled(); expect(f.kick).not.toHaveBeenCalled();
});
it("continues only the authenticated active project token and ignores obsolete runs", async () => {
  const body = signStudioWake({ familyId, projectId, token: studioProjectFixture().token, at: Date.now() });
  expect((await POST(request(body))).status).toBe(202); expect(f.kick).toHaveBeenCalledWith(familyId, projectId);
  f.kick.mockClear(); f.read.mockResolvedValue(studioProjectFixture({ state: "ready" })); expect((await POST(request(body))).status).toBe(202); expect(f.kick).not.toHaveBeenCalled();
});
