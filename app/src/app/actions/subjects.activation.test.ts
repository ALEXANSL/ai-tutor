import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ auth: vi.fn(), update: vi.fn(), family: vi.fn(), eq: vi.fn(), result: vi.fn(), cache: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: mock.cache }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: mock.auth }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => {
  mock.family(familyId);
  const chain = { eq: (key: string, value: unknown) => { mock.eq(key, value); return chain; }, select: () => chain, maybeSingle: mock.result };
  return { update: (table: string, values: unknown) => { mock.update(table, values); return chain; } };
} }));
import { toggleSubjectActiveAction } from "./subjects";
const subjectId = "11111111-1111-4111-8111-111111111111";
function input(active = "true") { const form = new FormData(); form.set("subjectId", subjectId); form.set("active", active); return form; }
beforeEach(() => { vi.clearAllMocks(); mock.auth.mockResolvedValue({ familyId: "own-family" }); mock.result.mockResolvedValue({ data: { id: subjectId }, error: null }); });
it("promotes the existing school placeholder and sets visibility in one family-scoped write", async () => {
  expect(await toggleSubjectActiveAction({ status: "idle" }, input())).toMatchObject({ status: "ok" });
  expect(mock.family).toHaveBeenCalledWith("own-family");
  expect(mock.update).toHaveBeenCalledExactlyOnceWith("subjects", { active: true, is_stub: false });
  expect(mock.eq.mock.calls).toEqual([["id", subjectId], ["kind", "school_subject"]]);
  expect(mock.cache).toHaveBeenCalledWith("/today"); expect(mock.cache).toHaveBeenCalledWith("/parent/materials");
});
it("allows turning the same school subject back off", async () => {
  expect(await toggleSubjectActiveAction({ status: "idle" }, input("false"))).toMatchObject({ status: "ok" });
  expect(mock.update).toHaveBeenCalledWith("subjects", { active: false, is_stub: false });
});
it("does not report success when no owned school subject matched or a write failed", async () => {
  for (const result of [{ data: null, error: null }, { data: null, error: { message: "DB error" } }]) {
    mock.result.mockResolvedValueOnce(result);
    expect(await toggleSubjectActiveAction({ status: "idle" }, input())).toMatchObject({ status: "error" });
  }
  expect(mock.cache).not.toHaveBeenCalled();
});
it("requires parent access and validates IDs before any write", async () => {
  const invalid = input(); invalid.set("subjectId", "bad");
  expect(await toggleSubjectActiveAction({ status: "idle" }, invalid)).toMatchObject({ status: "error" });
  mock.auth.mockRejectedValueOnce(new Error("parent required"));
  await expect(toggleSubjectActiveAction({ status: "idle" }, input())).rejects.toThrow("parent required");
  expect(mock.update).not.toHaveBeenCalled();
});
