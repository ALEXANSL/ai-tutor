import { beforeEach, expect, it, vi } from "vitest";
import { homeworkFixture } from "@/server/homework/__fixtures__/work";
const f = vi.hoisted(() => ({ access: vi.fn(), actor: vi.fn(), origin: vi.fn(), source: vi.fn(), uploads: vi.fn(), begin: vi.fn(), run: vi.fn(), after: vi.fn(), read: vi.fn(), recover: vi.fn() }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after: f.after }));
vi.mock("@/server/auth/guards", () => ({ requireLessonAccess: f.access }));
vi.mock("@/server/voice/service", () => ({ voiceActor: f.actor }));
vi.mock("@/server/voice/http", () => ({ sameOrigin: f.origin }));
vi.mock("@/server/homework/source", () => ({ homeworkSource: f.source }));
vi.mock("@/server/homework/uploads", () => ({ homeworkUploads: f.uploads, MAX_HOMEWORK_UPLOAD: 3145728 }));
vi.mock("@/server/homework/service", () => ({ beginHomework: f.begin, runHomework: f.run, recoverHomework: f.recover }));
vi.mock("@/server/homework/store", () => ({ readHomework: f.read }));
import { POST, GET } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
function request(extra = {}) { const form = new FormData(); form.set("command", JSON.stringify({ id, requestId: id, revision: 0, question: "Підготуй реферат", format: "docx", pages: [], target: homeworkFixture().target, ...extra })); return new Request("https://example.test/api/homework", { method: "POST", body: form }); }
beforeEach(() => { vi.clearAllMocks(); f.origin.mockReturnValue(true); f.access.mockResolvedValue({ familyId: "family" }); f.actor.mockResolvedValue({ child: { id: "child" } }); f.source.mockResolvedValue({ pages: [75] }); f.uploads.mockResolvedValue({ names: [], text: "", documents: [] }); f.begin.mockResolvedValue({ work: homeworkFixture({ state: "running" }), started: true }); f.read.mockResolvedValue(null); });
it("checks origin and authentication before starting any child generation", async () => {
  f.origin.mockReturnValue(false); expect((await POST(request())).status).toBe(403); expect(f.access).not.toHaveBeenCalled();
  f.origin.mockReturnValue(true); f.access.mockRejectedValueOnce(new Error("denied")); await expect(POST(request())).rejects.toThrow("denied"); expect(f.begin).not.toHaveBeenCalled();
});
it("returns a persisted accepted request before background work, without exposing stored source context", async () => {
  const response = await POST(request()); expect(response.status).toBe(202); expect(f.after).toHaveBeenCalledOnce(); expect(f.run).not.toHaveBeenCalled();
  const value = await response.json(); expect(value.work.context).toBeUndefined(); expect(value.work.childId).toBeUndefined();
  expect(f.begin.mock.calls[0]!.slice(0, 3)).toEqual(["family", "child", id]);
});
it("does not schedule a duplicate accepted operation and rejects arbitrary textbook pages", async () => {
  f.begin.mockResolvedValue({ work: homeworkFixture(), started: false }); await POST(request()); expect(f.after).not.toHaveBeenCalled();
  expect((await POST(request({ pages: [999] }))).status).toBe(400); expect(f.begin).toHaveBeenCalledTimes(1);
});
it("does not return a work that the family/child scoped store cannot access", async () => {
  expect((await GET(new Request(`https://example.test/api/homework?id=${id}`))).status).toBe(404);
  expect(f.read).toHaveBeenCalledWith("family", "child", id);
});
