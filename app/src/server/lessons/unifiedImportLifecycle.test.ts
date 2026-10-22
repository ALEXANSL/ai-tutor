import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyScope } from "@/server/db/family-scope";
const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), register: vi.fn(), scope: vi.fn() }));
vi.mock("@/server/jobs/runner", () => ({ enqueueJob: mocks.enqueue, registerJobHandler: mocks.register }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: mocks.scope }));
import { acquireUnifiedImport, findCompletedUnifiedImport, isUnifiedImportStoragePath, registerUnifiedImportJobs, scheduleUnifiedImportCleanup } from "./unifiedImportLifecycle";
const input = { subjectId: "subject", storagePath: "family/archive.zip", fingerprint: "a".repeat(64), format: "chapter_v3", packageKey: "book" };
beforeEach(() => { vi.clearAllMocks(); mocks.enqueue.mockResolvedValue(undefined); });
describe("import operation lifecycle", () => {
  it.each(["other/archive.zip", "family/nested/archive.zip", "family/../archive.zip", "family/archive.pdf", "family/evil\\archive.zip", "family/a\u0000.zip"])("rejects foreign or invalid storage selector %s", path => {
    expect(isUnifiedImportStoragePath("family", path)).toBe(false);
  });
  it("schedules bounded retention and propagates a failed cleanup registration", async () => {
    const before = Date.now(); await scheduleUnifiedImportCleanup("family", input.storagePath);
    const [family, , payload, options] = mocks.enqueue.mock.calls[0]!;
    expect(family).toBe("family"); expect(payload).toEqual({ storagePath: input.storagePath });
    expect(options.runAfter.getTime() - before).toBeGreaterThanOrEqual(86_400_000);
    mocks.enqueue.mockRejectedValueOnce(new Error("unavailable"));
    await expect(scheduleUnifiedImportCleanup("family", input.storagePath)).rejects.toThrow("unavailable");
  });
  it("uses the unique active-package lock to reject parallel imports", async () => {
    const chain = { eq: vi.fn(() => chain), lt: vi.fn(async () => ({ error: null })) };
    const insert = vi.fn((table: string, row: unknown) => { expect(table).toBe("jobs"); expect(row).toBeTruthy(); return { select: () => ({ single: async () => ({ error: { code: "23505" }, data: null }) }) }; });
    const scope = { familyId: "family", update: () => chain, insert } as unknown as FamilyScope;
    expect(await acquireUnifiedImport(scope, input)).toEqual({ busy: true });
    expect(insert.mock.calls[0]![1]).toMatchObject({ type: "course_zip.import", status: "running", payload: { fingerprint: input.fingerprint } });
  });
  it("does not trust a replay payload belonging to another subject", async () => {
    const chain = { eq: () => chain, order: () => chain, limit: () => chain, maybeSingle: async () => ({ error: null, data: { payload: { ...input, subjectId: "other", summary: { title: "Course", lessons: 1, tasks: 0, assetsUploaded: 0, warnings: [] } } } }) };
    expect(await findCompletedUnifiedImport({ familyId: "family", select: () => chain } as unknown as FamilyScope, input)).toBeNull();
  });
  it("cleanup postpones removal while the archive is in active use", async () => {
    registerUnifiedImportJobs();
    const handler = mocks.register.mock.calls.find(call => call[0] === "course_zip.cleanup")![1];
    const remove = vi.fn();
    const chain = { eq: () => chain, gt: () => chain, limit: () => chain, maybeSingle: async () => ({ error: null, data: { id: "active" } }) };
    mocks.scope.mockReturnValue({ select: () => chain, client: { storage: { from: () => ({ remove }) } } });
    expect(await handler.run({ family_id: "family", payload: { storagePath: input.storagePath } })).toEqual({ requeue: true, delaySeconds: 600 });
    expect(remove).not.toHaveBeenCalled();
  });
});
