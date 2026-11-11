import { beforeEach, expect, it, vi } from "vitest";
import { studioPlanFixture, studioProjectFixture } from "./__fixtures__/project";
import type { StudioProject } from "@/lib/studio";
const f = vi.hoisted(() => ({ project: null as StudioProject | null, rows: [] as Record<string, unknown>[], calls: vi.fn() }));
vi.mock("./store", () => ({ STUDIO_STEP: "studio.step", readStudioProject: async () => structuredClone(f.project), saveStudioProject: async (_family: string, _id: string, previous: StudioProject, changes: Partial<StudioProject>) => { if (previous.revision !== f.project!.revision) throw new Error("stale"); f.project = { ...f.project!, ...changes, revision: previous.revision + 1 }; return structuredClone(f.project); } }));
vi.mock("./sources", () => ({})); vi.mock("./publish", () => ({}));
vi.mock("./model", () => ({ studioModelConfig: async () => ({ route: { params: { max_tokens: 1000 } }, rates: {} }), studioReservation: () => 0.1, callStudioModel: f.calls }));
vi.mock("@/server/jobs/runner", () => ({ registerJobHandler: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  function query(values?: Record<string, unknown>, filters: ((row: Record<string, unknown>) => boolean)[] = []) {
    const run = () => { const rows = f.rows.filter(row => row.family_id === family && filters.every(filter => filter(row))); if (values) rows.forEach(row => Object.assign(row, values)); return { data: rows[0] ? structuredClone(rows[0]) : null, error: null }; };
    const value = (row: Record<string, unknown>, field: string) => field.startsWith("payload->>") ? (row.payload as Record<string, unknown>)[field.split("->>")[1]!] : row[field];
    const chain = { eq: (field: string, expected: unknown) => query(values, [...filters, row => value(row, field) === expected]), lte: (field: string, expected: string) => query(values, [...filters, row => String(value(row, field)) <= expected]), limit: () => chain, select: () => chain, maybeSingle: async () => run(), then: (resolve: (result: ReturnType<typeof run>) => unknown) => Promise.resolve(run()).then(resolve) }; return chain;
  }
  return { select: () => query(), update: (_table: string, values: Record<string, unknown>) => query(values) };
} }));
import { runStudioQueue } from "./workflow";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.clearAllMocks(); f.project = studioProjectFixture(); f.rows = [{ id: "step", family_id: "family", type: "studio.step", status: "queued", payload: { projectId: id, token: f.project.token }, attempts: 0, max_attempts: 1, run_after: new Date(0).toISOString() }, { id: "unrelated", family_id: "family", type: "ingest.extract", status: "queued", run_after: new Date(0).toISOString() }]; f.calls.mockResolvedValue({ result: studioPlanFixture, model: { provider: "openai", model: "test" }, costUsd: 0.01 }); });
it("claims a project step once under concurrent workers and never starts unrelated indexing jobs", async () => {
  await Promise.all([runStudioQueue("family", id, f.project!.token), runStudioQueue("family", id, f.project!.token)]);
  expect(f.calls).toHaveBeenCalledTimes(1); expect(f.project!.state).toBe("plan_ready"); expect(f.rows[0]!.status).toBe("done"); expect(f.rows[1]!.status).toBe("queued");
});
it("never claims another family's queued job", async () => { await runStudioQueue("other-family", id, f.project!.token); expect(f.calls).not.toHaveBeenCalled(); expect(f.rows[0]!.status).toBe("queued"); });
