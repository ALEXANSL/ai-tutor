import { beforeEach, describe, expect, it, vi } from "vitest";
import { studioProjectFixture } from "./__fixtures__/project";

const f = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>[]>(), errors: new Set<string>(),
  queries: [] as { family: string; table: string; columns: string; filters: [string, unknown][] }[],
  detail: vi.fn(), lesson: vi.fn(),
}));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.detail }));
vi.mock("@/server/video-script/source", () => ({ loadVideoLessonSource: f.lesson, VideoSourceError: class VideoSourceError extends Error {} }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => ({ select: (table: string, columns: string) => {
  if (!["subjects", "materials"].includes(table)) throw new Error("Base discovery must not fetch raw topics, chunks or book text.");
  const query = { family, table, columns, filters: [] as [string, unknown][] }; f.queries.push(query);
  const filters: ((row: Record<string, unknown>) => boolean)[] = [row => row.owner_family_id === family];
  let start = 0, end = Infinity, sort = "", ascending = true;
  const result = () => {
    if (f.errors.has(table)) return { data: null, error: { message: "database unavailable" } };
    const rows = [...(f.rows.get(table) ?? [])].filter(row => filters.every(filter => filter(row)));
    if (sort) rows.sort((a, b) => String(a[sort]).localeCompare(String(b[sort])) * (ascending ? 1 : -1));
    return { data: rows.slice(start, end), error: null };
  };
  const chain = {
    eq: (column: string, value: unknown) => { query.filters.push([column, value]); filters.push(row => row[column] === value); return chain; },
    neq: (column: string, value: unknown) => { query.filters.push([`${column}!=`, value]); filters.push(row => row[column] !== value); return chain; },
    in: (column: string, values: unknown[]) => { query.filters.push([column, values]); filters.push(row => values.includes(row[column])); return chain; },
    order: (column: string, options?: { ascending?: boolean }) => { sort = column; ascending = options?.ascending !== false; return chain; },
    range: (from: number, to: number) => { start = from; end = to + 1; return chain; },
    limit: (limit: number) => { end = limit; return chain; },
    returns: async () => result(),
    maybeSingle: async () => { const response = result(); return { ...response, data: response.data?.[0] ?? null }; },
  };
  return chain;
} }) }));

import { VideoSourceError } from "@/server/video-script/source";
import { studioBaseCandidates, studioPreparedBaseSources, type BaseTopicCandidate } from "./base-sources";
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const subjectId = uuid(1), topicId = uuid(101), materialId = uuid(201);
const request = () => studioProjectFixture().request;
const topic = (id = topicId) => ({ id, title: "Повний базовий урок", pageFrom: 42, pageTo: 84, literatureV3LessonId: uuid(301) });
const detail = (id = subjectId, topics = [topic()]) => ({ id, name: "Базовий предмет", active: true, childVisible: true, topics });
const candidate = (id = topicId): BaseTopicCandidate => ({ id, subjectId, title: "Базовий урок", pageFrom: 42, pageTo: 84 });
beforeEach(() => {
  vi.clearAllMocks(); f.rows.clear(); f.errors.clear(); f.queries.length = 0;
  f.detail.mockResolvedValue(detail());
  f.lesson.mockResolvedValue({ title: "Повний базовий урок", blocks: [{ id: "b1", title: "Пояснення", text: "Підготовлений навчальний текст" }, { id: "b2", title: "Приклад", text: "Розібраний навчальний приклад" }] });
});

describe("prepared subject inventory before book fallback", () => {
  it("uses all visible prepared topics, preserves their trusted link, and treats page bounds only as metadata", async () => {
    f.detail.mockResolvedValue(detail(subjectId, Array.from({ length: 43 }, (_, index) => ({ ...topic(uuid(1000 + index)), title: `Тема ${index + 1}`, pageFrom: index + 42, pageTo: index + 42 }))));
    const result = await studioBaseCandidates("family", { ...request(), subjectId, pageFrom: 1, pageTo: 2 });
    expect(result.topics).toHaveLength(43); expect(result.topics.at(-1)?.title).toBe("Тема 43");
    expect(result.topics[0]).toMatchObject({ subjectId, pageFrom: 42, href: `/literature-v3/${uuid(301)}` });
    expect(f.detail).toHaveBeenCalledWith("family", subjectId); expect(f.lesson).not.toHaveBeenCalled();
    expect(result.fallbackMaterialId).toBeNull();
  });
  it("does not use legacy unprepared topics or hidden subjects", async () => {
    f.detail.mockResolvedValue({ ...detail(), topics: [{ id: topicId, title: "Старий topic без готового уроку", pageFrom: 1, pageTo: 2 }] });
    expect((await studioBaseCandidates("family", { ...request(), subjectId })).topics).toEqual([]);
    f.detail.mockResolvedValue({ ...detail(), childVisible: false });
    expect((await studioBaseCandidates("family", { ...request(), subjectId })).topics).toEqual([]);
  });
  it("infers the basic subject through an owner-checked book without reading raw book text", async () => {
    f.rows.set("materials", [{ owner_family_id: "family", id: materialId, subject_id: subjectId, status: "ready" }]);
    const result = await studioBaseCandidates("family", { ...request(), materialId });
    expect(result.subjectName).toBe("Базовий предмет"); expect(result.fallbackMaterialId).toBe(materialId);
    expect(f.detail).toHaveBeenCalledWith("family", subjectId);
    expect(f.queries[0]).toMatchObject({ family: "family", table: "materials", columns: "subject_id" });
  });
  it("prefers the explicitly assigned subject over the chosen book association", async () => {
    f.rows.set("materials", [{ owner_family_id: "family", id: materialId, subject_id: uuid(2), status: "ready" }]);
    const result = await studioBaseCandidates("family", { ...request(), subjectId, materialId });
    expect(f.detail).toHaveBeenCalledWith("family", subjectId); expect(result.fallbackMaterialId).toBe(materialId);
  });
  it("preserves the latest available family textbook as a fallback selector without loading its content", async () => {
    f.rows.set("materials", [
      { owner_family_id: "other", id: uuid(202), subject_id: subjectId, kind: "textbook", use_in_lessons: true, status: "ready", added_at: "2026-11-20" },
      { owner_family_id: "family", id: uuid(203), subject_id: subjectId, kind: "textbook", use_in_lessons: true, status: "ready_partial", added_at: "2026-11-18" },
      { owner_family_id: "family", id: uuid(204), subject_id: subjectId, kind: "textbook", use_in_lessons: true, status: "ready", added_at: "2026-11-10" },
      { owner_family_id: "family", id: uuid(205), subject_id: subjectId, kind: "textbook", use_in_lessons: false, status: "ready", added_at: "2026-11-21" },
    ]);
    expect((await studioBaseCandidates("family", { ...request(), subjectId })).fallbackMaterialId).toBe(uuid(203));
    expect(f.lesson).not.toHaveBeenCalled();
  });
  it("rejects a missing, removed or foreign explicitly chosen material", async () => {
    f.rows.set("materials", [{ owner_family_id: "other", id: materialId, subject_id: subjectId, status: "ready" }]);
    await expect(studioBaseCandidates("family", { ...request(), materialId })).rejects.toThrow("книга недоступна");
    expect(f.detail).not.toHaveBeenCalled();
  });
  it("paginates the school-subject inventory without keyword filtering or a first-eight cutoff", async () => {
    f.rows.set("subjects", Array.from({ length: 53 }, (_, index) => ({ id: uuid(index + 1), owner_family_id: "family", kind: "school_subject", active: true })));
    f.detail.mockImplementation(async (_family, id: string) => detail(id, [topic(uuid(Number(id.slice(-12)) + 1000))]));
    const result = await studioBaseCandidates("family", request());
    expect(result.topics).toHaveLength(53); expect(f.detail).toHaveBeenCalledTimes(53);
    expect(f.queries.filter(query => query.table === "subjects")).toHaveLength(2);
    expect(result.fallbackMaterialId).toBeNull(); expect(result.subjectName).toBeNull();
  });
  it("propagates discovery database failures and subject reader failures", async () => {
    f.errors.add("subjects"); await expect(studioBaseCandidates("family", request())).rejects.toThrow("перелік базових предметів");
    f.errors.clear(); f.errors.add("materials"); await expect(studioBaseCandidates("family", { ...request(), materialId })).rejects.toThrow("перевірити предмет");
    f.errors.clear(); f.detail.mockRejectedValue(new Error("read failed"));
    await expect(studioBaseCandidates("family", { ...request(), subjectId })).rejects.toThrow("read failed");
  });
  it("does not turn a missing or mismatched selected subject into an empty successful inventory", async () => {
    f.detail.mockResolvedValue(null); await expect(studioBaseCandidates("family", { ...request(), subjectId })).rejects.toThrow("предмет недоступний");
    f.detail.mockResolvedValue(detail(uuid(2))); await expect(studioBaseCandidates("family", { ...request(), subjectId })).rejects.toThrow("предмет недоступний");
  });
});

describe("actual prepared lesson source loading", () => {
  it("reads actual educational blocks for selected known topics with unique stable source identifiers", async () => {
    const result = await studioPreparedBaseSources("family", [candidate(), candidate(uuid(102))], [topicId, topicId, uuid(102)]);
    expect(f.lesson).toHaveBeenCalledTimes(2); expect(f.lesson).toHaveBeenCalledWith("family", subjectId, topicId);
    expect(result.sources).toHaveLength(4); expect(new Set(result.sources.map(source => source.id)).size).toBe(4);
    expect(result.sources[0]).toMatchObject({ id: `base-${topicId}-1`, text: "Підготовлений навчальний текст", kind: "lesson", page: null });
    expect(result.warnings).toEqual([]); expect(f.queries).toEqual([]);
  });
  it("rejects unselected or invalid topic identifiers before any source read", async () => {
    await expect(studioPreparedBaseSources("family", [candidate()], [uuid(999)])).rejects.toThrow("перевіреному переліку");
    await expect(studioPreparedBaseSources("family", [candidate("bad-id")], ["bad-id"])).rejects.toThrow("перевіреному переліку");
    expect(f.lesson).not.toHaveBeenCalled();
  });
  it("warns about unusable/question-only lessons without claiming the base source covers the requested topic", async () => {
    f.lesson.mockRejectedValueOnce(new VideoSourceError("Самих запитань недостатньо."));
    const result = await studioPreparedBaseSources("family", [candidate()], [topicId]);
    expect(result.sources).toEqual([]); expect(result.warnings.join(" ")).toContain("Покриття теми ним не підтверджене");
  });
  it("propagates genuine source read failures instead of quietly pretending the base material is absent", async () => {
    f.lesson.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(studioPreparedBaseSources("family", [candidate()], [topicId])).rejects.toThrow("database unavailable");
  });
  it("bounds source loading concurrency at four and keeps the semantic selection order", async () => {
    let active = 0, maxActive = 0;
    f.lesson.mockImplementation(async (_family, _subject, id: string) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return { title: "База", blocks: [{ id: "b1", title: "Пояснення", text: id }] };
    });
    const candidates = Array.from({ length: 11 }, (_, index) => candidate(uuid(index + 500)));
    const result = await studioPreparedBaseSources("family", candidates, candidates.map(topic => topic.id));
    expect(maxActive).toBe(4); expect(result.sources.map(source => source.text)).toEqual(candidates.map(topic => topic.id));
  });
});
