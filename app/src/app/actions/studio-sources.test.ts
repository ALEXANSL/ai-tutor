import { beforeEach, expect, it, vi } from "vitest";
const id = "11111111-1111-4111-8111-111111111111";
const f = vi.hoisted(() => ({ auth: vi.fn(), kick: vi.fn(), confirm: vi.fn(), reindex: vi.fn(), queries: [] as unknown[], material: {} as Record<string, unknown> | null, chunks: [] as unknown[] }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.auth }));
vi.mock("@/server/jobs/kick", () => ({ kickJobs: f.kick }));
vi.mock("@/server/ingest/pipeline", () => ({ confirmBookOcr: f.confirm, requestReindex: f.reindex }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => ({ select: (table: string) => {
  f.queries.push([family, table]); const query = { eq: (key: string, value: unknown) => { f.queries.push([key, value]); return query; }, neq: () => query, order: () => query, limit: () => query, maybeSingle: async () => ({ data: f.material, error: null }), returns: async () => ({ data: f.chunks, error: null }) }; return query;
} }) }));
import { studioSourceStatusAction, resumeStudioSourceAction } from "./studio-sources";
beforeEach(() => {
  vi.clearAllMocks(); f.queries = []; f.auth.mockResolvedValue({ familyId: "own-family", ctx: { appUserId: "parent" } });
  f.material = { name: "Original.docx", title: null, status: "indexing", progress: { step: "embed" }, page_count: 2, char_count: 1000, structure_outline_result: { kind: "source_document", warnings: ["Зображення не розпізнавалися"] } }; f.chunks = [{ page: 1, locator: "Тема", text: "Навчальний текст" }];
});
it("requires parent access before reading or resuming a source", async () => {
  f.auth.mockRejectedValue(new Error("parent only"));
  await expect(studioSourceStatusAction(id)).rejects.toThrow("parent only"); await expect(resumeStudioSourceAction(id)).rejects.toThrow("parent only"); expect(f.queries).toEqual([]);
});
it("scopes polling to the family and returns a bounded text preview, diagnostics and actual readiness", async () => {
  f.chunks = [{ page: 1, locator: "Тема", text: "x".repeat(10000) }];
  const result = await studioSourceStatusAction(id);
  expect(f.queries).toContainEqual(["own-family", "materials"]); expect(f.queries).toContainEqual(["own-family", "chunks"]); expect(f.queries).toContainEqual(["id", id]); expect(f.queries).toContainEqual(["material_id", id]);
  expect(result.hasText).toBe(true); expect(result.preview.length).toBeLessThanOrEqual(5000); expect(result.warnings).toContain("Зображення не розпізнавалися"); expect(f.kick).toHaveBeenCalledOnce();
});
it("does not expose a foreign/missing source or inspect its chunks", async () => {
  f.material = null; await expect(studioSourceStatusAction(id)).rejects.toThrow("стан матеріалу"); expect(f.queries).not.toContainEqual(["own-family", "chunks"]);
});
it("does not claim a half-written extraction is ready just because a chunk exists", async () => {
  f.material!.progress = { step: "extract" }; expect((await studioSourceStatusAction(id)).hasText).toBe(false);
});
it("only confirms the explicit paused OCR task, passing the real parent and family", async () => {
  f.material!.status = "scan_awaiting_ocr"; await resumeStudioSourceAction(id, true);
  expect(f.confirm).toHaveBeenCalledWith("own-family", id, "parent"); expect(f.reindex).not.toHaveBeenCalled();
  f.material!.status = "indexing"; await expect(resumeStudioSourceAction(id, true)).rejects.toThrow("стан розпізнавання");
});
it("retries a failed task without accepting a new file and rejects retries on a ready source", async () => {
  f.material!.status = "error"; await resumeStudioSourceAction(id); expect(f.reindex).toHaveBeenCalledWith("own-family", id);
  f.material!.status = "ready"; await expect(resumeStudioSourceAction(id)).rejects.toThrow("виконується або завершена");
});
