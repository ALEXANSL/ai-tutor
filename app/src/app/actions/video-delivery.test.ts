import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ auth: vi.fn(), sign: vi.fn(), probe: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireChild: mock.auth, requireParentAccess: vi.fn() }));
vi.mock("@/server/lessons/videoLessons", () => ({ getVideoLessonUrlById: mock.sign, deleteVideoLesson: vi.fn(), listTopicVideos: vi.fn() }));
vi.mock("@/server/subjects/queries", () => ({ listSubjectTopicOptions: vi.fn() }));
vi.mock("@/lib/video-delivery-probe", () => ({ probeVideoDelivery: mock.probe }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { inspectVideoDeliveryAction } from "./video-lessons";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.clearAllMocks(); mock.auth.mockResolvedValue({ ctx: { familyId: "family" } }); mock.sign.mockResolvedValue("https://example.com/video.mp4?token=PRIVATE"); mock.probe.mockResolvedValue({ status: 206, bytes: 1024, error: null }); });
describe("authorized video delivery diagnostics", () => {
  it("authorizes before accessing a private file", async () => {
    mock.auth.mockRejectedValue(new Error("login required"));
    await expect(inspectVideoDeliveryAction(id)).rejects.toThrow(); expect(mock.sign).not.toHaveBeenCalled(); expect(mock.probe).not.toHaveBeenCalled();
  });
  it("accepts only an id and uses the existing family/visibility signing gate", async () => {
    expect(await inspectVideoDeliveryAction("https://example.com/arbitrary")).toEqual({ status: "error" }); expect(mock.probe).not.toHaveBeenCalled();
    const result = await inspectVideoDeliveryAction(id);
    expect(mock.sign).toHaveBeenCalledWith("family", id); expect(result).toMatchObject({ status: "ok", report: { status: 206 } }); expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("does not probe an unavailable or unauthorized file", async () => {
    mock.sign.mockResolvedValue(null); expect(await inspectVideoDeliveryAction(id)).toEqual({ status: "error" }); expect(mock.probe).not.toHaveBeenCalled();
  });
});
