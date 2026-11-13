import { beforeEach, expect, it, vi } from "vitest";
import { schoolPacketFixture } from "@/server/eschool/__fixtures__/packet";
const f = vi.hoisted(() => ({ parent: vi.fn(), lesson: vi.fn(), actor: vi.fn(), save: vi.fn(), update: vi.fn(), disconnect: vi.fn(), detail: vi.fn(), read: vi.fn(), context: vi.fn(), publications: vi.fn(), subjects: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.parent, requireLessonAccess: f.lesson }));
vi.mock("@/server/voice/service", () => ({ voiceActor: f.actor }));
vi.mock("@/server/eschool/service", () => ({ importSchoolPacket: f.save, updateSchoolEntry: f.update, disconnectSchool: f.disconnect, schoolSubjects: f.subjects }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.detail }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/eschool/store", () => ({ readSchoolDoc: f.read, SCHOOL_ENTRY: "eschool.entry" }));
vi.mock("@/server/eschool/contextMatch", () => ({ resolveSchoolContext: f.context }));
vi.mock("@/server/studio/links", () => ({ studioPublicationsForSubject: f.publications }));
import { resolveSchoolContextAction, importSchoolAction, setSchoolStatusAction, disconnectSchoolAction } from "./eschool";
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

it("runs contextual search only for the owned child entry and visible ready subject lessons", async () => {
  const subjectId = "22222222-2222-4222-8222-222222222222", entryId = "11111111-1111-4111-8111-111111111111";
  const row = { subjectId, topicId: null, source: schoolPacketFixture().entries[0] };
  const ready = { id: "ready", title: "Тема", literatureV3LessonId: "lesson" };
  f.detail.mockResolvedValue({ id: subjectId, childVisible: true, topics: [ready, { id: "not-ready", title: "Old" }, { ...ready, id: "derivative" }] });
  f.read.mockResolvedValue(row); f.publications.mockResolvedValue([{ baseTopicId: "ready", lessons: [{ topicId: "derivative" }] }]);
  f.context.mockResolvedValue({ state: "done", topicId: "ready", reason: "Збіг", confidence: 0.95 });
  expect((await resolveSchoolContextAction({ entryId, subjectId })).status).toBe("ok");
  expect(f.context).toHaveBeenCalledWith("family", "child", subjectId, row, [ready]);
  f.context.mockClear(); f.read.mockResolvedValue({ ...row, subjectId: "other-subject" });
  expect((await resolveSchoolContextAction({ entryId, subjectId })).status).toBe("error"); expect(f.context).not.toHaveBeenCalled();
  f.read.mockResolvedValue(row); f.detail.mockResolvedValue({ childVisible: false, topics: [ready] });
  expect((await resolveSchoolContextAction({ entryId, subjectId })).status).toBe("error"); expect(f.context).not.toHaveBeenCalled();
  expect((await resolveSchoolContextAction({ entryId, subjectId, familyId: "forged" })).status).toBe("error");
});
