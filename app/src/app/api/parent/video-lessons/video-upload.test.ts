import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const family = "11111111-1111-4111-8111-111111111111", topic = "22222222-2222-4222-8222-222222222222";
const path = `${family}/${topic}-33333333-3333-4333-8333-333333333333.mp4`;
const mock = vi.hoisted(() => ({ auth: vi.fn(), save: vi.fn(), info: vi.fn(), sign: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: mock.auth }));
vi.mock("@/server/lessons/videoLessons", () => ({ saveVideoLesson: mock.save }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ storage: { from: () => ({ createSignedUploadUrl: mock.sign }) } }) }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "topic", subject_id: "history" }, error: null }) }) }), client: { storage: { from: () => ({ info: mock.info }) } } }) }));
import { POST as complete } from "./upload/complete/route";
import { POST as init } from "./upload/route";
const request = (body: unknown) => new NextRequest("http://localhost/api/parent/video-lessons/upload", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); mock.auth.mockResolvedValue({ familyId: family });
  mock.info.mockResolvedValue({ data: { size: 100, contentType: "video/mp4" }, error: null });
  mock.save.mockResolvedValue("video-id"); mock.sign.mockResolvedValue({ data: { path, signedUrl: "signed", token: "token" }, error: null });
});
const body = () => ({ topicId: topic, storagePath: path, mimeType: "video/mp4", sizeBytes: 100 });
describe("video upload server boundary", () => {
  it("requires parent authorization before issuing a storage token or saving", async () => {
    mock.auth.mockRejectedValue(new Error("not parent"));
    await expect(init(request({ topicId: topic, size: 100, mimeType: "video/mp4" }))).rejects.toThrow();
    await expect(complete(request(body()))).rejects.toThrow(); expect(mock.sign).not.toHaveBeenCalled(); expect(mock.save).not.toHaveBeenCalled();
  });
  it("rejects foreign paths, traversal and a file minted for another topic", async () => {
    for (const storagePath of [`other/${topic}-33333333-3333-4333-8333-333333333333.mp4`, `${family}/../bad.mp4`, `${family}/44444444-4444-4444-8444-444444444444-33333333-3333-4333-8333-333333333333.mp4`]) {
      expect((await complete(request({ ...body(), storagePath }))).status).toBe(400);
    }
    expect(mock.info).not.toHaveBeenCalled(); expect(mock.save).not.toHaveBeenCalled();
  });
  it("does not persist a nonexistent or incomplete upload", async () => {
    mock.info.mockResolvedValueOnce({ data: null, error: { message: "not found" } });
    expect((await complete(request(body()))).status).toBe(400);
    expect((await complete(request({ ...body(), sizeBytes: 200 }))).status).toBe(400); expect(mock.save).not.toHaveBeenCalled();
  });
  it("saves verified storage metadata, not a claimed MIME", async () => {
    expect((await complete(request({ ...body(), mimeType: "text/plain" }))).status).toBe(200);
    expect(mock.save).toHaveBeenCalledWith(family, topic, "history", path, "video/mp4", 100);
  });
  it("rejects zero/absent/oversized declarations and unsupported file types", async () => {
    for (const size of [0, -1, 600 * 1024 * 1024]) expect((await init(request({ topicId: topic, size, mimeType: "video/mp4" }))).status).toBeGreaterThanOrEqual(400);
    expect((await init(request({ topicId: topic, size: 100, mimeType: "text/html" }))).status).toBe(415); expect(mock.sign).not.toHaveBeenCalled();
  });
});
