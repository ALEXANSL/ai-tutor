import { beforeEach, expect, it, vi } from "vitest";
import { studioProjectFixture } from "./__fixtures__/project";
const f = vi.hoisted(() => ({ subject: vi.fn(), lesson: vi.fn(), rpc: vi.fn(), book: vi.fn(), chunks: vi.fn(), snapshot: vi.fn(), filters: [] as unknown[] }));
vi.mock("./source-catalog", () => ({ readStudioSourceCatalog: async () => null, studioSourceAnalysisContract: () => "test-contract" }));
vi.mock("./source-corpus", () => ({ snapshotStudioSources: f.snapshot }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
vi.mock("@/server/video-script/source", () => ({ loadVideoLessonSource: f.lesson, VideoSourceError: class VideoSourceError extends Error {} }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  function query(table: string) { let after = -1, from = 0, to = Infinity, limit = Infinity;
    const chain = { eq: (field: string, value: unknown) => { f.filters.push([family, table, field, value]); return chain; }, neq: () => chain, in: (field: string, value: unknown) => { f.filters.push([family, table, field, value]); return chain; }, gt: (_field: string, value: number) => { after = value; return chain; }, gte: (_field: string, value: number) => { from = value; return chain; }, lte: (_field: string, value: number) => { to = value; return chain; }, order: () => chain, limit: (value: number) => { limit = value; return chain; }, maybeSingle: () => f.book(), returns: async () => {
      if (table === "materials") return { data: [{ id: "book", title: "Підручник інформатики", name: "book" }], error: null };
      const result = await f.chunks(); return { ...result, data: result.data?.filter((row: { ordinal: number; page: number | null }) => row.ordinal > after && (from === 0 || (row.page !== null && row.page >= from && row.page <= to))).slice(0, limit) };
    } }; return chain; }

  return { select: query, client: { rpc: f.rpc } };
} }));
import { loadStudioSources } from "./sources";
beforeEach(() => { vi.clearAllMocks(); f.filters = []; f.subject.mockResolvedValue({ id: "subject", name: "Інформатика", topics: [{ id: "topic", title: "Координати", literatureV3LessonId: "base" }] }); f.lesson.mockResolvedValue({ title: "Координати", blocks: [{ title: "Основний текст", text: "Доступний матеріал базового уроку" }] }); f.rpc.mockResolvedValue({ data: [{ chunk_id: "found" }], error: null }); f.chunks.mockResolvedValue({ data: [{ id: "found", ordinal: 0, material_id: "book", page: 20, text: "Повний знайдений фрагмент сторінки" }], error: null }); f.snapshot.mockResolvedValue({id:"corpus",partCount:4,chunkCount:201,characterCount:100000,blankChunks:0,pageFrom:1,pageTo:201}); f.book.mockResolvedValue({ data: { id: "book", title: "Підручник", name: "book", status:"ready", content_hash:"hash", indexed_at:"stamp" }, error: null }); });
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
  await expect(loadStudioSources("family", { ...studioProjectFixture().request, materialId: "book" })).rejects.toThrow("не знайдено читабельного");
});

it("uses every chunk of a small uploaded source without relying on a keyword match", async () => {
  f.rpc.mockResolvedValue({ data: [], error: null });
  const result = await loadStudioSources("family", { ...studioProjectFixture().request, materialId: "book" });
  expect(result.sources.some(source => source.text === "Повний знайдений фрагмент сторінки")).toBe(true);
  expect(result.sourceNotes.join(" ")).toContain("весь доступний розпізнаний текст");
  expect(f.rpc).not.toHaveBeenCalled();
});
it("does not mistake a truncated 201-chunk scan for the full source", async () => {
  f.chunks.mockResolvedValue({ data: Array.from({ length: 201 }, (_, index) => ({ id: `chunk-${index}`, ordinal:index, material_id: "book", page: index + 1, text: "Матеріал" })), error: null });
  const result = await loadStudioSources("family", { ...studioProjectFixture().request, materialId: "book" });
  expect(f.rpc).not.toHaveBeenCalled(); expect(f.snapshot.mock.calls[0]![1].filter((source: {kind:string})=>source.kind==="book")).toHaveLength(201); expect(result.sourceCorpus?.partCount).toBe(4);
});

it("passes all 32 presentation fragments including explicit teacher/reference annotations",async()=>{
 f.book.mockResolvedValue({data:{id:"book",title:"Цифровий слід",name:"slides.pptx",status:"ready",content_hash:"h",indexed_at:"s",structure_outline_result:{kind:"source_document"}},error:null});
 f.chunks.mockResolvedValue({data:Array.from({length:32},(_,i)=>({id:`s${i}`,ordinal:i,material_id:"book",page:i+1,text:i===31?"ДЛЯ ВЧИТЕЛЯ\nДжерела презентації":`Тема слайда ${i+1}: повне пояснення`})),error:null});
 const result=await loadStudioSources("family",{...studioProjectFixture().request,materialId:"book"});
 expect(result.sources.filter(source=>source.kind==="book")).toHaveLength(32); expect(result.sources.at(-1)?.audience).toBe("teacher"); expect(result.sources.some(source=>source.text.includes("Тема слайда 31"))).toBe(true); expect(f.rpc).not.toHaveBeenCalled();
});
it("snapshots every part of an oversized explicitly uploaded document instead of substituting search",async()=>{
 f.book.mockResolvedValue({data:{id:"book",title:"Презентація",name:"slides.pptx",status:"ready",content_hash:"h",indexed_at:"s",structure_outline_result:{kind:"source_document"}},error:null});
 f.chunks.mockResolvedValue({data:Array.from({length:201},(_,i)=>({id:`s${i}`,ordinal:i,material_id:"book",page:i+1,text:"Текст"})),error:null});
 const result=await loadStudioSources("family",{...studioProjectFixture().request,materialId:"book"});expect(result.sourceCorpus).toBeDefined();expect(f.snapshot.mock.calls[0]![1].filter((source: {kind:string})=>source.kind==="book")).toHaveLength(201);expect(f.rpc).not.toHaveBeenCalled();
});

it("reads all 43 pages of a chosen range without a 31-page or 150-fragment cutoff",async()=>{
 f.chunks.mockResolvedValue({data:Array.from({length:306},(_,i)=>({id:`p${i}`,ordinal:i,material_id:"book",page:i+1,text:`Матеріал сторінки ${i+1}. `.repeat(40)})),error:null});
 const result=await loadStudioSources("family",{...studioProjectFixture().request,materialId:"book",pageFrom:42,pageTo:84});
 expect(result.sourceCorpus).toBeDefined();const sources=f.snapshot.mock.calls[0]![1].filter((source: {kind:string})=>source.kind==="book");expect(sources).toHaveLength(43);expect(sources[0].page).toBe(42);expect(sources.at(-1).page).toBe(84);expect(f.rpc).not.toHaveBeenCalled();
});
it("stops before generation when a book is indexing or changes during the paginated scan",async()=>{
 f.book.mockResolvedValueOnce({data:{id:"book",name:"book",status:"indexing"}});await expect(loadStudioSources("family",{...studioProjectFixture().request,materialId:"book"})).rejects.toThrow("Дочекайся");expect(f.chunks).not.toHaveBeenCalled();
 f.book.mockResolvedValueOnce({data:{id:"book",name:"book",status:"ready",content_hash:"before",indexed_at:"s"}}).mockResolvedValueOnce({data:{id:"book",name:"book",status:"ready",content_hash:"after",indexed_at:"s"}});
 await expect(loadStudioSources("family",{...studioProjectFixture().request,materialId:"book"})).rejects.toThrow("змінилася");expect(f.snapshot).not.toHaveBeenCalled();
});
