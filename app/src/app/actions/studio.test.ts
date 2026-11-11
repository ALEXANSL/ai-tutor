import { beforeEach, expect, it, vi } from "vitest";
import { studioProjectFixture } from "@/server/studio/__fixtures__/project";
const f = vi.hoisted(() => ({ parent: vi.fn(), child: vi.fn(), start: vi.fn(), resume: vi.fn(), pause: vi.fn(), read: vi.fn(), save: vi.fn(), kick: vi.fn(), links: vi.fn(), text: vi.fn(), cleanup: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.parent, requireChild: f.child }));
vi.mock("@/server/studio/workflow", () => ({ startStudio: f.start, resumeStudio: f.resume, pauseStudio: f.pause }));
vi.mock("@/server/studio/store", () => ({ readStudioProject: f.read, saveStudioProject: f.save, STUDIO_STEP: "studio.step" }));
vi.mock("@/server/studio/wake", () => ({ kickStudio: f.kick }));
vi.mock("@/server/studio/links", () => ({ studioLinksForPath: f.links }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));
vi.mock("unpdf", () => ({ getDocumentProxy: async () => ({ numPages: 10, cleanup: f.cleanup }), extractText: f.text }));
import { createStudioAction, commandStudioAction, pollStudioAction, withdrawStudioAction, pauseStudioAction, extractStudioFileAction, studioLessonLinksAction } from "./studio";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.clearAllMocks(); f.parent.mockResolvedValue({ familyId: "own-family" }); f.child.mockResolvedValue({ ctx: { familyId: "child-family" } }); f.start.mockResolvedValue(id); f.read.mockResolvedValue(studioProjectFixture({ state: "plan_ready" })); });
it("rejects a child/unauthorized caller before reading drafts, running models, extracting files or publishing", async () => {
  f.parent.mockRejectedValue(new Error("parent only"));
  await expect(createStudioAction({})).rejects.toThrow(); await expect(commandStudioAction({})).rejects.toThrow(); await expect(pollStudioAction(id)).rejects.toThrow(); await expect(withdrawStudioAction(id, 0)).rejects.toThrow(); await expect(extractStudioFileAction(new FormData())).rejects.toThrow(); await expect(pauseStudioAction(id, 0)).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.text).not.toHaveBeenCalled();
});
it("uses the authorized family and a stable request ID, rejects forged selectors before paid work", async () => {
  expect(await createStudioAction({ requestId: id, request: studioProjectFixture().request })).toEqual({ status: "ok", id });
  expect(f.start).toHaveBeenCalledWith("own-family", studioProjectFixture().request, id);
  expect((await createStudioAction({ requestId: "invalid", request: studioProjectFixture().request })).status).toBe("error"); expect(f.start).toHaveBeenCalledTimes(1);
  expect((await commandStudioAction({ id, revision: -1, command: "publish" })).status).toBe("error"); expect(f.resume).not.toHaveBeenCalled();
});
it("provides only whitelisted public lesson navigation to the authenticated child family", async () => {
  f.links.mockResolvedValue({ back: "/literature-v3/base", links: [] });
  expect(await studioLessonLinksAction("/literature-v3/lesson")).toEqual({ back: "/literature-v3/base", links: [] }); expect(f.links).toHaveBeenCalledWith("child-family", "/literature-v3/lesson"); expect(f.read).not.toHaveBeenCalled();
});
it("does not turn empty PDF-page labels into source material for an image-only scan", async () => {
  f.text.mockResolvedValue({ text: Array(10).fill("   "), totalPages: 10 }); const form = new FormData(); form.set("file", new File(["pdf-fixture"], "scan.pdf", { type: "application/pdf" }));
  const result = await extractStudioFileAction(form); expect(result.status).toBe("error"); if (result.status === "error") expect(result.message).toContain("текстового шару"); expect(f.cleanup).toHaveBeenCalled();
});
