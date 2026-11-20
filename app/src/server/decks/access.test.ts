import { describe, it, expect, vi } from "vitest";
const f = vi.hoisted(() => ({ parent: vi.fn(), lesson: vi.fn(), get: vi.fn(), subject: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireLessonAccess: f.lesson, requireParentAccess: f.parent }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
vi.mock("./store", () => ({ getDeck: f.get }));
import { accessibleDeck } from "./access";
describe("slide and recording visibility", () => {
  it("requires publication and an active subject for student access", async () => {
    f.lesson.mockResolvedValue({ familyId: "family" });
    for (const [published, visible, allowed] of [[false,true,false],[true,false,false],[true,true,true]]) {
      f.get.mockResolvedValue({ published, subjectId: "s", state: "ready" });
      f.subject.mockResolvedValue({ childVisible: visible });
      expect(!!await accessibleDeck("deck", false)).toBe(allowed);
    }
    expect(f.get).toHaveBeenCalledWith("family","deck");
  });
  it("enforces the parent guard on preview URLs", async () => {
    f.parent.mockRejectedValueOnce(new Error("denied"));
    await expect(accessibleDeck("deck", true)).rejects.toThrow("denied");
  });
});
