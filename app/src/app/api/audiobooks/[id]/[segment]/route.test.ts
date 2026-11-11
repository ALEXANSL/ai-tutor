import { beforeEach, expect, it, vi } from "vitest";
import { audioId, familyId, partFixture } from "@/server/audiobooks/__fixtures__/part";
const f = vi.hoisted(() => ({ guard: vi.fn(), read: vi.fn(), url: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireLessonAccess: f.guard }));
vi.mock("@/server/audiobooks/store", () => ({ readAudioPart: f.read }));
vi.mock("@/server/audiobooks/storage", () => ({ signedAudioUrl: f.url }));
import { GET } from "./route";
beforeEach(() => { vi.clearAllMocks(); f.guard.mockResolvedValue({ familyId }); f.url.mockResolvedValue("https://storage.example/signed.mp3"); });
it("does not read or sign anything without authentication", async () => { f.guard.mockRejectedValueOnce(new Error("redirect")); await expect(GET(new Request("https://app.test"), { params: Promise.resolve({ id: audioId, segment: "0" }) })).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled(); });
it("blocks drafts, removed audio and missing segments before signing", async () => {
  for (const part of [null, partFixture(), partFixture({ state: "ready", published: false }), partFixture({ state: "deleted", published: true })]) { f.read.mockResolvedValueOnce(part); expect((await GET(new Request("https://app.test"), { params: Promise.resolve({ id: audioId, segment: "0" }) })).status).toBe(404); }
  expect(f.url).not.toHaveBeenCalled();
});
it("signs only the server stored key in the caller family, with private noncached redirect", async () => {
  f.read.mockResolvedValue(partFixture({ state: "ready", published: true, segments: [{ text: "text", key: "trusted-key", ready: true }] }));
  const response = await GET(new Request("https://app.test"), { params: Promise.resolve({ id: audioId, segment: "0" }) }); expect(response.status).toBe(307); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(f.url).toHaveBeenCalledWith(familyId, audioId, "trusted-key");
});
it("rejects traversal or negative indices", async () => { expect((await GET(new Request("https://app.test"), { params: Promise.resolve({ id: audioId, segment: "../0" }) })).status).toBe(404); expect(f.read).not.toHaveBeenCalled(); });
