import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ auth: vi.fn(), parse: vi.fn(), download: vi.fn(), remove: vi.fn(), persist: vi.fn(), replay: vi.fn(), acquire: vi.fn(), complete: vi.fn(), fail: vi.fn(), packageSubject: null as string | null }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: mock.auth }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/supabase/clients", () => ({ createServiceClient: () => ({ storage: { from: () => ({ download: mock.download, remove: mock.remove }) } }) }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string, client: unknown) => ({ familyId, client, select: (table: string) => {
  const chain = { eq: () => chain, maybeSingle: async () => ({ error: null, data: table === "subjects" ? { id: "subject" } : mock.packageSubject ? { id: "existing", subject_id: mock.packageSubject } : null }) };
  return chain;
} }) }));
vi.mock("@/server/lessons/unifiedCourseArchive", () => ({ parseUnifiedCourseArchive: mock.parse }));
vi.mock("@/server/lessons/literatureV3Persist", () => ({ persistLiteratureV3Package: mock.persist }));
vi.mock("@/server/lessons/literatureV2Persist", () => ({ persistLiteratureV2Package: mock.persist }));
vi.mock("@/server/lessons/mathCourseV2Persist", () => ({ persistMathCourseV2Package: mock.persist }));
vi.mock("@/server/lessons/coursePersist", () => ({ persistCoursePackage: mock.persist }));
vi.mock("@/server/lessons/literatureExtraction", () => ({ persistLiteratureTopic: mock.persist }));
vi.mock("@/server/lessons/unifiedImportLifecycle", () => ({
  isUnifiedImportStoragePath: (family: string, path: string) => path === `${family}/course.zip`,
  findCompletedUnifiedImport: mock.replay, acquireUnifiedImport: mock.acquire, completeUnifiedImport: mock.complete, failUnifiedImport: mock.fail,
}));
import { inspectUnifiedCourseAction, importUnifiedCourseAction } from "./unified-course-import";
const input = { subjectId: "11111111-1111-4111-8111-111111111111", storagePath: "family/course.zip" };
const summary = { title: "Курс", lessons: 1, tasks: 2, assetsUploaded: 0, warnings: [] };
beforeEach(() => {
  vi.clearAllMocks(); mock.packageSubject = null;
  mock.auth.mockResolvedValue({ familyId: "family" });
  mock.download.mockResolvedValue({ data: new Blob(["zip bytes"]), error: null });
  mock.remove.mockResolvedValue({ error: null }); mock.replay.mockResolvedValue(null);
  mock.acquire.mockResolvedValue({ jobId: "job" }); mock.complete.mockResolvedValue(undefined); mock.fail.mockResolvedValue(undefined);
  mock.persist.mockResolvedValue({ assetsUploaded: 0, assetUploadFailures: [] });
  mock.parse.mockReturnValue({ format: "chapter_v3", title: "Курс", packageId: "book", counts: { lessons: 1, tasks: 2, images: 0, pdfs: 0 }, errors: [], warnings: [], assetFiles: new Map(), parsed: { taskKeys: [{ answer: "PRIVATE ANSWER" }] } });
});
async function verified() { const result = await inspectUnifiedCourseAction(input); if (result.status !== "ready") throw new Error(result.message); return { ...input, fingerprint: result.preview.fingerprint }; }
describe("unified import server boundary", () => {
  it("checks authentication and family path before reading any object", async () => {
    mock.auth.mockRejectedValueOnce(new Error("Потрібен вхід"));
    expect((await inspectUnifiedCourseAction(input)).status).toBe("error");
    expect((await inspectUnifiedCourseAction({ ...input, storagePath: "other/course.zip" })).status).toBe("error");
    expect(mock.download).not.toHaveBeenCalled(); expect(mock.persist).not.toHaveBeenCalled();
  });
  it("returns public counts only, with no teacher answer payload", async () => {
    const result = await inspectUnifiedCourseAction(input);
    expect(result.status).toBe("ready"); expect(JSON.stringify(result)).not.toContain("PRIVATE ANSWER"); expect(mock.persist).not.toHaveBeenCalled();
  });
  it("blocks invalid content and cross-subject package moves", async () => {
    mock.parse.mockReturnValueOnce({ errors: [{ file: "course.json", field: "lesson", message: "invalid" }] });
    expect((await inspectUnifiedCourseAction(input)).status).toBe("error");
    mock.packageSubject = "another-subject";
    expect((await inspectUnifiedCourseAction(input)).status).toBe("error"); expect(mock.persist).not.toHaveBeenCalled();
  });
  it("does not write if archive bytes changed after inspection", async () => {
    const commit = await verified(); mock.download.mockResolvedValue({ data: new Blob(["changed"]), error: null });
    expect((await importUnifiedCourseAction(commit)).status).toBe("error"); expect(mock.persist).not.toHaveBeenCalled();
  });
  it("blocks concurrent import and leaves the ZIP for retry", async () => {
    const commit = await verified(); mock.acquire.mockResolvedValue({ busy: true });
    expect((await importUnifiedCourseAction(commit)).status).toBe("error"); expect(mock.persist).not.toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled();
  });
  it("saves durable success before deleting staging, and replays without the blob", async () => {
    const commit = await verified(); expect((await importUnifiedCourseAction(commit)).status).toBe("ok");
    expect(mock.complete.mock.invocationCallOrder[0]).toBeLessThan(mock.remove.mock.invocationCallOrder[0]!);
    mock.download.mockClear(); mock.persist.mockClear(); mock.replay.mockResolvedValue(summary);
    expect(await importUnifiedCourseAction(commit)).toEqual({ status: "ok", summary });
    expect(mock.download).not.toHaveBeenCalled(); expect(mock.persist).not.toHaveBeenCalled();
  });
  it("reports partial failure honestly and retains staging for retry", async () => {
    const commit = await verified(); mock.persist.mockRejectedValue(new Error("write failed"));
    const result = await importUnifiedCourseAction(commit);
    expect(result).toMatchObject({ status: "error", retryable: true });
    expect(JSON.stringify(result)).toContain("Частина матеріалів"); expect(mock.fail).toHaveBeenCalled(); expect(mock.remove).not.toHaveBeenCalled();
  });
});
