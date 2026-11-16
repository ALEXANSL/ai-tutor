import { beforeEach, expect, it, vi } from "vitest";
import { studioProjectFixture } from "./__fixtures__/project";
const f = vi.hoisted(() => ({ subject: vi.fn(), lesson: vi.fn(), rpc: vi.fn(), book: vi.fn(), chunks: vi.fn(), filters: [] as unknown[] }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
vi.mock("@/server/video-script/source", () => ({ loadVideoLessonSource: f.lesson, VideoSourceError: class VideoSourceError extends Error {} }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  function query(table: string) { const chain = { eq: (field: string, value: unknown) => { f.filters.push([family, table, field, value]); return chain; }, neq: () => chain, in: (field: string, value: unknown) => { f.filters.push([family, table, field, value]); return chain; }, gte: () => chain, lte: () => chain, order: () => chain, limit: () => chain, maybeSingle: () => f.book(), returns: () => table === "materials" ? Promise.resolve({ data: [{ id: "book", title: "Підручник інформатики", name: "book" }], error: null }) : f.chunks() }; return chain; }
  return { select: query, client: { rpc: f.rpc } };
} }));
import { loadStudioSources } from "./sources";
beforeEach(() => { vi.clearAllMocks(); f.filters = []; f.subject.mockResolvedValue({ id: "subject", name: "Інформатика", topics: [{ id: "topic", title: "Координати", literatureV3LessonId: "base" }] }); f.lesson.mockResolvedValue({ title: "Координати", blocks: [{ title: "Основний текст", text: "Доступний матеріал базового уроку" }] }); f.rpc.mockResolvedValue({ data: [{ chunk_id: "found" }], error: null }); f.chunks.mockResolvedValue({ data: [{ id: "found", material_id: "book", page: 20, text: "Повний знайдений фрагмент сторінки" }], error: null }); f.book.mockResolvedValue({ data: { id: "book", title: "Підручник", name: "book" }, error: null }); });
it("combines exact base-lesson text and full scoped search chunks and preserves a trusted return link", async () => {
  const request = { ...studioProjectFixture().request, mode: "extension" as const, subjectId: "subject", topicId: "topic" };
  const result = await loadStudioSources("family", request);
  expect(result.subjectName).toBe("Інформатика"); expect(result.baseHref).toBe("/literature-v3/base"); expect(result.sources.some(source => source.text === "Повний знайдений фрагмент сторінки")).toBe(true);
  expect(result.sources.find(source => source.kind === "book")?.title).toBe("Підручник інформатики");
  expect(f.rpc.mock.calls[0]![1]).toMatchObject({ p_family_id: "family", p_subject_id: "subject", p_query_embedding: null });
  expect(f.filters).toContainEqual(["family", "chunks", "id", ["found"]]);
});
it("refuses a missing/foreign book before searching or reading its chunks", async () => {
  f.book.mockResolvedValue({ data: null, error: null });
  await expect(loadStudioSources("family", { ...studioProjectFixture().request, materialId: "foreign-book" })).rejects.toThrow("книга недоступна");
  expect(f.rpc).not.toHaveBeenCalled(); expect(f.chunks).not.toHaveBeenCalled();
});
it("does not pretend a whole book was read or silently proceed when the chosen book has no readable text", async () => {
  f.rpc.mockResolvedValue({ data: [], error: null }); f.chunks.mockResolvedValue({ data: [], error: null });
  await expect(loadStudioSources("family", { ...studioProjectFixture().request, materialId: "book" })).rejects.toThrow("не знайдено читабельних");
});

it("uses every chunk of a small uploaded source without relying on a keyword match", async () => {
  f.rpc.mockResolvedValue({ data: [], error: null });
  const result = await loadStudioSources("family", { ...studioProjectFixture().request, materialId: "book" });
  expect(result.sources.some(source => source.text === "Повний знайдений фрагмент сторінки")).toBe(true);
  expect(result.sourceNotes.join(" ")).toContain("весь розпізнаний текст");
  expect(f.rpc).not.toHaveBeenCalled();
});
it("does not mistake a truncated 31-chunk scan for the full source", async () => {
  f.chunks.mockResolvedValue({ data: Array.from({ length: 31 }, (_, index) => ({ id: `chunk-${index}`, material_id: "book", page: index + 1, text: "Матеріал" })), error: null });
  const result = await loadStudioSources("family", { ...studioProjectFixture().request, materialId: "book" });
  expect(f.rpc).toHaveBeenCalled();
  expect(result.sourceNotes.join(" ")).not.toContain("весь розпізнаний текст");
});
