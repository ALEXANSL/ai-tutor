import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ auth: vi.fn(), extract: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.auth }));
vi.mock("@/app/actions/studio", () => ({ extractStudioFileAction: f.extract }));
import { POST } from "./route";
beforeEach(() => { vi.clearAllMocks(); f.auth.mockResolvedValue({ familyId: "family" }); f.extract.mockResolvedValue({ status: "ok", text: "Навчальний текст" }); });
it("requires parent authorization before parsing a multipart body", async () => {
  f.auth.mockRejectedValue(new Error("parent only")); await expect(POST(new Request("http://localhost/api/parent/studio/source", { method: "POST" }))).rejects.toThrow(); expect(f.extract).not.toHaveBeenCalled();
});
it("accepts a file above the Server Actions 1MB limit through its bounded multipart route", async () => {
  const form = new FormData(); form.set("file", new File([new Uint8Array(1100000)], "source.pdf", { type: "application/pdf" }));
  const response = await POST(new Request("http://localhost/api/parent/studio/source", { method: "POST", body: form })); expect(response.status).toBe(200); expect(f.extract).toHaveBeenCalledTimes(1);
});
it("rejects excessive bodies and invalid multipart without invoking extraction", async () => {
  const response = await POST(new Request("http://localhost/api/parent/studio/source", { method: "POST", headers: { "content-length": String(5 * 1024 * 1024) } })); expect(response.status).toBe(413);
  expect((await POST(new Request("http://localhost/api/parent/studio/source", { method: "POST" }))).status).toBe(400); expect(f.extract).not.toHaveBeenCalled();
});
