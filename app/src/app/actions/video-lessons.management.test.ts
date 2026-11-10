import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ auth: vi.fn(), url: vi.fn(), remove: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.auth }));
vi.mock("@/server/lessons/videoLessons", () => ({ getParentVideoUrl: f.url, deleteVideoLesson: f.remove }));
vi.mock("@/server/subjects/queries", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: f.revalidate }));
import { getParentVideoUrlAction, deleteVideoLessonAction } from "./video-lessons";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.clearAllMocks(); f.auth.mockResolvedValue({ familyId: "family" }); f.url.mockResolvedValue("https://example.invalid/private-video"); f.remove.mockResolvedValue({ cleanupPending: true }); });
it("requires parent access before signing/downloading/deleting, including forged client calls", async () => {
  f.auth.mockRejectedValue(new Error("not parent"));
  await expect(getParentVideoUrlAction(id, true)).rejects.toThrow(); await expect(deleteVideoLessonAction(id)).rejects.toThrow();
  expect(f.url).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
});
it("uses the authorized family and validated ID, never a client file path", async () => {
  expect((await getParentVideoUrlAction(id, true)).status).toBe("ok"); expect(f.url).toHaveBeenCalledWith("family", id, true);
  expect((await getParentVideoUrlAction("foreign/path")).status).toBe("error"); expect(f.url).toHaveBeenCalledTimes(1);
  expect(await deleteVideoLessonAction(id)).toEqual({ status: "ok", cleanupPending: true }); expect(f.revalidate).toHaveBeenCalledWith("/parent/videos");
});
