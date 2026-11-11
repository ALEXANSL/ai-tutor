import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ parent: vi.fn(), child: vi.fn(), start: vi.fn(), command: vi.fn(), read: vi.fn(), position: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.parent, requireLessonAccess: f.child }));
vi.mock("@/server/audiobooks/workflow", () => ({ startAudioPart: f.start, commandAudioPart: f.command }));
vi.mock("@/server/audiobooks/store", () => ({ readAudioPart: f.read }));
vi.mock("@/server/audiobooks/positions", () => ({ readAudioPosition: vi.fn(), saveAudioPosition: f.position }));
vi.mock("@/server/audiobooks/wake", () => ({ kickAudioPart: vi.fn() }));
vi.mock("@/server/audiobooks/library", () => ({ libraryBook: vi.fn(), originalBookText: vi.fn() }));
import { createAudioPartAction, commandAudioPartAction, audioPositionAction } from "./audiobooks";
import { familyId, audioId, requestFixture, partFixture } from "@/server/audiobooks/__fixtures__/part";
beforeEach(() => { vi.clearAllMocks(); f.parent.mockResolvedValue({ familyId }); f.child.mockResolvedValue({ familyId, ctx: { appUserId: "own-user" } }); });
it("requires parent before accepting a paid preparation or command", async () => { f.parent.mockRejectedValue(new Error("denied")); await expect(createAudioPartAction({})).rejects.toThrow(); await expect(commandAudioPartAction({})).rejects.toThrow(); expect(f.start).not.toHaveBeenCalled(); expect(f.command).not.toHaveBeenCalled(); });
it("validates consent and page limits before creating a task", async () => {
  for (const request of [{ ...requestFixture, retainPrepared: false }, { ...requestFixture, to: 1000 }]) expect((await createAudioPartAction({ id: audioId, request })).status).toBe("error"); expect(f.start).not.toHaveBeenCalled();
});
it("keeps private drafts inaccessible through position actions", async () => { f.read.mockResolvedValue(partFixture()); await expect(audioPositionAction(audioId, {})).rejects.toThrow("не опубліковано"); expect(f.position).not.toHaveBeenCalled(); });
it("saves progress for the authenticated user only with valid segment bounds", async () => {
  f.read.mockResolvedValue(partFixture({ state: "ready", published: true, segments: [{ text: "text", key: "key", ready: true }] }));
  const position = { segment: 0, seconds: 20, speed: 1.25, bookmark: null }; await audioPositionAction(audioId, position); expect(f.position).toHaveBeenCalledWith(familyId, "own-user", audioId, position);
  await expect(audioPositionAction(audioId, { ...position, segment: 2 })).rejects.toThrow();
});
