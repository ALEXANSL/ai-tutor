import { beforeEach, expect, it, vi } from "vitest";
import type { StudioDraftValues } from "@/server/studio/drafts";
const ID = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const f = vi.hoisted(() => ({ auth: vi.fn(), save: vi.fn(), read: vi.fn(), list: vi.fn(), launch: vi.fn(), kick: vi.fn(), revalidate: vi.fn(), rethrow: vi.fn(), start: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.auth }));
vi.mock("next/cache", () => ({ revalidatePath: f.revalidate }));
vi.mock("next/navigation", () => ({ unstable_rethrow: f.rethrow }));
vi.mock("@/server/studio/wake", () => ({ kickStudio: f.kick }));
vi.mock("@/server/studio/workflow", () => ({ startStudio: f.start }));
vi.mock("@/server/studio/drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/studio/drafts")>()),
  saveStudioFormDraft: f.save, readStudioFormDraft: f.read, listStudioFormDrafts: f.list, launchStudioFormDraft: f.launch,
}));
import { StudioFormDraftConflictError } from "@/server/studio/drafts";
import { launchStudioFormDraftAction, listStudioFormDraftsAction, readStudioFormDraftAction, saveStudioFormDraftAction } from "./studio-drafts";
function values(changes: Partial<StudioDraftValues> = {}): StudioDraftValues {
  return { mode: "course", title: "", idea: "", targetLanguage: null, age: 0, grade: 0, lessonCount: 0, minutes: 0, budgetUsd: 0, subjectId: null, topicId: null, materialId: null, pageFrom: 9, pageTo: null, sourceText: "Мої нотатки", ...changes };
}
beforeEach(() => {
  vi.resetAllMocks(); f.auth.mockResolvedValue({ familyId: "owned-family" });
  f.save.mockResolvedValue({ id: ID, revision: 2 }); f.launch.mockResolvedValue(PROJECT);
  f.read.mockResolvedValue({ id: ID, revision: 0, values: values(), projectId: null }); f.list.mockResolvedValue([]);
});
it("requires parent access before reading, listing, saving or launching", async () => {
  f.auth.mockRejectedValue(new Error("parent only"));
  await expect(readStudioFormDraftAction(ID)).rejects.toThrow("parent only");
  await expect(listStudioFormDraftsAction()).rejects.toThrow("parent only");
  await expect(saveStudioFormDraftAction({ id: ID, revision: null, values: values() })).rejects.toThrow("parent only");
  await expect(launchStudioFormDraftAction({ id: ID, revision: 0 })).rejects.toThrow("parent only");
  expect(f.read).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled(); expect(f.kick).not.toHaveBeenCalled();
});
it("saves incomplete raw fields in the authenticated family without starting or waking paid work", async () => {
  const raw = values({ idea: "  ", pageFrom: 12, pageTo: 3, lessonCount: 80 });
  expect(await saveStudioFormDraftAction({ id: ID, revision: null, values: raw })).toEqual({ status: "ok", id: ID, revision: 2 });
  expect(f.save).toHaveBeenCalledWith("owned-family", ID, null, raw);
  expect(f.revalidate).toHaveBeenCalledWith("/parent/studio");
  expect(f.start).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled(); expect(f.kick).not.toHaveBeenCalled();
});
it("returns owned saved values and a nullable missing draft without mutating anything", async () => {
  const saved = await readStudioFormDraftAction(ID);
  expect(saved).toMatchObject({ id: ID, values: values() }); expect(f.read).toHaveBeenCalledWith("owned-family", ID);
  f.read.mockResolvedValue(null); expect(await readStudioFormDraftAction(ID)).toBeNull();
  f.list.mockResolvedValue([saved]); expect(await listStudioFormDraftsAction()).toEqual([saved]); expect(f.list).toHaveBeenCalledWith("owned-family");
  expect(f.save).not.toHaveBeenCalled(); expect(f.kick).not.toHaveBeenCalled();
});
it.each([
  { id: "invalid", revision: null, values: values() },
  { id: ID, revision: -1, values: values() },
  { id: ID, revision: 1.2, values: values() },
  { id: ID, revision: null, values: { ...values(), sourceText: "x".repeat(40001) } },
  { id: ID, revision: null, values: { ...values(), extraPrivateConfig: "not accepted" } },
  { id: ID, revision: null, values: values(), familyId: "forged-family" },
])("rejects invalid inputs or dynamic extras before storage", async (raw) => {
  expect((await saveStudioFormDraftAction(raw)).status).toBe("error"); expect(f.save).not.toHaveBeenCalled(); expect(f.kick).not.toHaveBeenCalled();
});
it("reports CAS conflicts without starting generation or claiming that the edit was saved", async () => {
  f.save.mockRejectedValue(new StudioFormDraftConflictError());
  const result = await saveStudioFormDraftAction({ id: ID, revision: 0, values: values() });
  expect(result).toMatchObject({ status: "error", message: expect.stringContaining("вже змінено") });
  expect(f.revalidate).not.toHaveBeenCalled(); expect(f.kick).not.toHaveBeenCalled();
});
it("starts background wake only after the owned launch promise durably resolves", async () => {
  let resolve!: (id: string) => void;
  f.launch.mockReturnValue(new Promise<string>(done => { resolve = done; }));
  const launching = launchStudioFormDraftAction({ id: ID, revision: 2 });
  await Promise.resolve(); await Promise.resolve();
  expect(f.launch).toHaveBeenCalledWith("owned-family", ID, 2); expect(f.kick).not.toHaveBeenCalled();
  resolve(PROJECT); expect(await launching).toEqual({ status: "ok", id: PROJECT });
  expect(f.kick).toHaveBeenCalledWith("owned-family", PROJECT); expect(f.revalidate).toHaveBeenCalledWith("/parent/studio");
});
it("does not wake work after an invalid, incomplete or failed launch", async () => {
  expect((await launchStudioFormDraftAction({ id: ID, revision: null })).status).toBe("error"); expect(f.launch).not.toHaveBeenCalled();
  f.launch.mockRejectedValue(new Error("OPENAI_API_KEY=sensitive-test-token internal database error"));
  const result = await launchStudioFormDraftAction({ id: ID, revision: 0 });
  expect(result.status).toBe("error"); expect(JSON.stringify(result)).not.toContain("sensitive-test-token");
  expect(f.kick).not.toHaveBeenCalled(); expect(f.revalidate).not.toHaveBeenCalled();
});
it("rethrows framework redirects rather than hiding them as form-save errors", async () => {
  const redirect = new Error("NEXT_REDIRECT");
  f.save.mockRejectedValue(redirect); f.rethrow.mockImplementation(error => { if (error === redirect) throw error; });
  await expect(saveStudioFormDraftAction({ id: ID, revision: null, values: values() })).rejects.toBe(redirect);
  expect(f.kick).not.toHaveBeenCalled();
});
it("rethrows framework redirects from a failed launch without a wake", async () => {
  const redirect = new Error("NEXT_REDIRECT"); f.launch.mockRejectedValue(redirect);
  f.rethrow.mockImplementation(error => { if (error === redirect) throw error; });
  await expect(launchStudioFormDraftAction({ id: ID, revision: 0 })).rejects.toBe(redirect); expect(f.kick).not.toHaveBeenCalled();
});
