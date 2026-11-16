import { beforeEach, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { SOURCE_MIME } from "@/lib/source-files";
import type { JobRow } from "@/server/jobs/runner";
const f = vi.hoisted(() => ({ bytes: new Uint8Array(), material: {} as Record<string, unknown>, chunks: [] as unknown[], sections: [] as Record<string, unknown>[], queue: vi.fn(), recognize: vi.fn(), failChunks: false, budget: "ok", inserts: 0 }));
vi.mock("@/server/drive/service", () => ({ getDriveToken: async () => async () => "server-token" }));
vi.mock("@/server/drive/google", async original => ({ ...await original<typeof import("@/server/drive/google")>(), downloadFile: async () => f.bytes }));
vi.mock("@/server/ai/router", () => ({ callStructured: vi.fn(), callVisionStructured: vi.fn(), embedTexts: vi.fn() }));
vi.mock("@/server/ai/store", () => ({ getBudget: async () => ({ state: f.budget }), loadPrice: vi.fn(), loadRoute: vi.fn() }));
vi.mock("@/server/studio/photoSource", () => ({ recognizeStudioPage: f.recognize }));
vi.mock("@/server/jobs/runner", () => ({ enqueueJob: f.queue, registerJobHandler: vi.fn() }));
vi.mock("@/server/lessons/warmup", () => ({ warmAheadForSubject: vi.fn() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  const chain = (table: string, operation = "select", value?: unknown) => {
    const filters: [string, unknown][] = [];
    function result() {
      if (operation === "update") { Object.assign(f.material, value); return { error: null }; }
      if (operation === "delete") { if (table === "chunks") f.chunks = []; return { error: null }; }
      if (operation === "insert") {
        if (table === "chunks") { if (f.failChunks) { f.failChunks = false; return { error: { message: "transient failure" } }; } f.chunks.push(...value as unknown[]); }
        return { error: null };
      }
      if (operation === "upsert") { f.sections.push(...value as Record<string, unknown>[]); return { error: null }; }
      if (operation === "count") return { count: f.chunks.length };
      if (table === "materials") {
        if (filters.some(([key]) => key === "drive_file_id")) return { data: f.material.registered ? { id: "material", status: f.material.status } : null, error: null };
        return { data: f.material, error: null };
      }
      if (table === "material_sections") return { data: [], error: null };
      return { data: null, error: null };
    }
    const q = { eq: (key: string, val: unknown) => { filters.push([key, val]); return q; }, in: () => q, maybeSingle: async () => result(), returns: async () => result(), then: (resolve: (val: unknown) => unknown) => Promise.resolve(result()).then(resolve) };
    return q;
  };
  return { familyId: family, select: (table: string) => chain(table), update: (table: string, value: unknown) => chain(table, "update", value), insert: (table: string, value: unknown) => chain(table, "insert", value), upsert: (table: string, value: unknown) => chain(table, "upsert", value), delete: (table: string) => chain(table, "delete"), count: (table: string) => chain(table, "count"), client: { from: () => ({ insert: (row: Record<string, unknown>) => ({ select: () => ({ single: async () => { f.inserts++; f.material = { ...row, id: "material", registered: true }; return { data: { id: "material" }, error: null }; } }) }) }) } };
} }));
import { runExtract, ingestUploadedMaterial } from "./pipeline";
const job = { id: "job", family_id: "family", type: "ingest.extract", payload: { materialId: "material" }, attempts: 1, max_attempts: 3 } as JobRow;
beforeEach(() => {
  vi.clearAllMocks(); f.chunks = []; f.sections = []; f.failChunks = false; f.budget = "ok"; f.inserts = 0;
  f.material = { id: "material", name: "notes.txt", mime: "text/plain", format: "manual", drive_file_id: "DriveFile123", status: "queued", content_hash: null, title: null, structure_outline_result: null };
  f.bytes = strToU8("Розібрані приклади та навчальний текст. ".repeat(8));
  f.recognize.mockResolvedValue({ text: "Original English exercise and Ukrainian explanation. ".repeat(5), warnings: ["Нижній край обрізано"] });
});
it("indexes native text into ordered chunks/sections without the legacy AI textbook generator", async () => {
  await runExtract(job);
  expect(f.chunks.length).toBeGreaterThan(0); expect(f.sections[0]).toMatchObject({ title: "Частина тексту 1", page_from: 1, status: "ready" });
  expect(f.material.progress).toMatchObject({ step: "embed" }); expect(f.queue.mock.calls.map(call => call[1])).toEqual(["ingest.embed"]);
  expect(f.recognize).not.toHaveBeenCalled(); expect(f.material.structure_outline_result).toMatchObject({ kind: "source_document" });
});
it("recognizes an uploaded image once and reuses the saved result after a downstream DB failure", async () => {
  Object.assign(f.material, { name: "page.png", mime: "image/png" }); f.bytes = new Uint8Array([137, 80, 78, 71]); f.failChunks = true;
  await expect(runExtract(job)).rejects.toThrow("chunks insert failed");
  expect(f.material.structure_outline_result).toMatchObject({ kind: "source_image", warnings: ["Нижній край обрізано"] });
  await runExtract(job); expect(f.recognize).toHaveBeenCalledTimes(1); expect(f.chunks.length).toBeGreaterThan(0);
  expect(f.recognize.mock.calls[0]![0]).toBe("family"); expect(f.recognize.mock.calls[0]![2]).toBe("material");
});
it("does not automatically repeat an uncertain paid OCR error", async () => {
  Object.assign(f.material, { name: "page.png", mime: "image/png" }); f.recognize.mockRejectedValue(new Error("provider timeout"));
  await expect(runExtract(job)).rejects.toMatchObject({ code: "ai_failed" }); expect(f.recognize).toHaveBeenCalledTimes(1);
});
it("still protects existing ZIP-imported manual sources from accidental extraction", async () => {
  Object.assign(f.material, { name: "Imported chapter", mime: "application/zip" });
  await expect(runExtract(job)).rejects.toMatchObject({ code: "extract_failed" }); expect(f.chunks).toHaveLength(0);
});
it("extracts native DOCX using the MIME even though the DB representation is manual", async () => {
  Object.assign(f.material, { name: "lesson.docx", mime: SOURCE_MIME.docx });
  f.bytes = zipSync({ "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>Документ із завданням для майбутнього уроку.</w:t></w:r></w:p></w:body></w:document>') });
  await runExtract(job); expect(JSON.stringify(f.chunks)).toContain("Документ із завданням");
});
it("makes completion idempotent and repairs an existing queued upload without duplicating the material", async () => {
  f.material = {};
  const file = { id: "DriveFile123", name: "lesson.docx", mimeType: SOURCE_MIME.docx, format: "docx" as const, size: 1234, modifiedTime: null, md5Checksum: null };
  await ingestUploadedMaterial("family", file); await ingestUploadedMaterial("family", file);
  expect(f.inserts).toBe(1); expect(f.material).toMatchObject({ format: "manual", mime: SOURCE_MIME.docx, owner_family_id: "family" }); expect(f.queue).toHaveBeenCalledTimes(2);
});
