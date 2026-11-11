import { beforeEach, expect, it, vi } from "vitest";
import { schoolPacketFixture } from "@/server/eschool/__fixtures__/packet";
const f = vi.hoisted(() => ({ parent: vi.fn(), lesson: vi.fn(), actor: vi.fn(), save: vi.fn(), update: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.parent, requireLessonAccess: f.lesson }));
vi.mock("@/server/voice/service", () => ({ voiceActor: f.actor }));
vi.mock("@/server/eschool/service", () => ({ importSchoolPacket: f.save, updateSchoolEntry: f.update, disconnectSchool: f.disconnect }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { importSchoolAction, setSchoolStatusAction, disconnectSchoolAction } from "./eschool";
beforeEach(() => { vi.clearAllMocks(); f.parent.mockResolvedValue({ familyId: "family" }); f.lesson.mockResolvedValue({ familyId: "family" }); f.actor.mockResolvedValue({ child: { id: "child" } }); f.save.mockResolvedValue({ count: 2, repeated: false }); f.update.mockResolvedValue({}); });
it("requires parent access before importing or disconnecting and derives family/child server-side", async () => {
  f.parent.mockRejectedValueOnce(new Error("denied")); await expect(importSchoolAction(schoolPacketFixture())).rejects.toThrow("denied"); expect(f.save).not.toHaveBeenCalled();
  await importSchoolAction(schoolPacketFixture()); expect(f.save.mock.calls[0]!.slice(0, 2)).toEqual(["family", "child"]);
  f.parent.mockRejectedValueOnce(new Error("denied")); await expect(disconnectSchoolAction()).rejects.toThrow(); expect(f.disconnect).not.toHaveBeenCalled();
});
it("lets the child change only task status, rejecting injected subject mappings or ownership fields", async () => {
  const command = { id: "11111111-1111-4111-8111-111111111111", revision: 0, status: "done" };
  expect((await setSchoolStatusAction({ ...command, subjectId: "forged" })).status).toBe("error"); expect(f.update).not.toHaveBeenCalled();
  await setSchoolStatusAction(command); expect(f.update).toHaveBeenCalledWith("family", "child", command.id, 0, { status: "done" });
});
