import { beforeEach, expect, it, vi } from "vitest";
import type { SchoolEntry } from "@/lib/eschool";
import type { SubjectTopicOption } from "@/server/subjects/queries";
import { schoolPacketFixture } from "./__fixtures__/packet";
const f = vi.hoisted(() => ({ cache: new Map<string, object>(), model: vi.fn(), config: vi.fn(), source: vi.fn(), search: vi.fn(), claim: vi.fn() }));
vi.mock("./contextStore", async original => ({ ...await original<typeof import("./contextStore")>(),
  readContextMatch: async (_family: string, _child: string, id: string) => f.cache.get(id) ?? null,
  claimContextMatch: async (_family: string, id: string) => { if (!f.claim() || f.cache.has(id)) return false; f.cache.set(id, { state: "pending", topicId: null, reason: "", confidence: 0 }); return true; },
  finishContextMatch: async (_family: string, id: string, _child: string, value: object) => { f.cache.set(id, value); },
}));
vi.mock("./contextModel", () => ({ callContextModel: f.model, contextModelConfig: f.config }));
vi.mock("@/server/video-script/source", () => ({ loadVideoLessonSource: f.source }));
vi.mock("@/server/search/search", () => ({ searchMaterials: f.search }));
import { resolveSchoolContext } from "./contextMatch";
import { contextMatchId } from "./contextStore";
const packet = schoolPacketFixture();
const entry: SchoolEntry = { version: 1, revision: 0, childId: "PRIVATE_CHILD", identity: packet.identity, source: { ...packet.entries[1]!, topic: "Чому нагріта кулька не проходить крізь кільце?", text: "Поясніть дослід із кулькою та кільцем." }, capturedAt: packet.capturedAt, syncedAt: packet.capturedAt, status: "todo", changed: false, subjectId: "subject", topicId: null, lessonHref: null, workHref: null };
const topics = [{ id: "thermal", title: "Теплові явища. Розширення металу", pageFrom: 25, pageTo: 27, literatureV3LessonId: "lesson" }, { id: "another", title: "Електричний струм", pageFrom: 30, pageTo: 32, literatureV3LessonId: "lesson2" }] as SubjectTopicOption[];
const text = "Нагрівання спричиняє розширення металу, а під час охолодження він стискається.";
const answer = { topicId: "thermal", confidence: 0.96, reason: "Урок пояснює теплове розширення, яке спостерігають у досліді з кулькою.", evidence: text };
const run = () => resolveSchoolContext("family", "child", "subject", entry, topics);
beforeEach(() => { vi.clearAllMocks(); f.cache.clear(); f.claim.mockReturnValue(true); f.config.mockResolvedValue({}); f.search.mockResolvedValue({ hits: [{ subjectId: "other", snippet: "PRIVATE_OTHER_SUBJECT" }], mode: "hybrid" }); f.source.mockResolvedValue({ blocks: [{ title: "Дослід", text }] }); f.model.mockReset().mockResolvedValueOnce({ topicIds: ["thermal"] }).mockResolvedValueOnce(answer); });
it("finds a genuinely paraphrased topic using content, validates evidence and caches the result", async () => {
  expect(await run()).toMatchObject({ state: "done", topicId: "thermal" });
  expect(await run()).toMatchObject({ topicId: "thermal" }); expect(f.model).toHaveBeenCalledTimes(2); expect(f.search).toHaveBeenCalledTimes(1);
  const prompts = f.model.mock.calls.map(call => JSON.stringify(call[2])).join("\n");
  expect(prompts).toContain(text); expect(prompts).not.toContain("PRIVATE_"); expect(f.source).toHaveBeenCalledWith("family", "subject", "thermal");
});
it("separates cache by family, child, changed task and candidate catalogue", () => {
  const id = contextMatchId("family", "child", "subject", entry, topics);
  expect(contextMatchId("other", "child", "subject", entry, topics)).not.toBe(id);
  expect(contextMatchId("family", "other", "subject", entry, topics)).not.toBe(id);
  expect(contextMatchId("family", "child", "subject", { ...entry, source: { ...entry.source, text: "Нове ДЗ" } }, topics)).not.toBe(id);
  expect(contextMatchId("family", "child", "subject", entry, topics.slice(1))).not.toBe(id);
});
it("does not pay for a known/manual match, an inaccessible manual topic or an empty catalogue", async () => {
  expect(await resolveSchoolContext("family", "child", "subject", { ...entry, topicId: "thermal" }, topics)).toMatchObject({ topicId: "thermal" });
  expect(await resolveSchoolContext("family", "child", "subject", { ...entry, topicId: "hidden" }, topics)).toMatchObject({ topicId: null });
  await resolveSchoolContext("family", "child", "subject", entry, []); expect(f.model).not.toHaveBeenCalled();
});
it("deduplicates concurrent or abandoned requests without a second paid call", async () => {
  f.claim.mockReturnValue(false); expect(await run()).toMatchObject({ state: "pending" }); expect(f.model).not.toHaveBeenCalled();
});
it.each([{ ...answer, confidence: 0.7 }, { ...answer, evidence: "Цитата, якої не було у наданому змісті уроку" }])("refuses low confidence or invented grounding", async result => {
  f.model.mockReset().mockResolvedValueOnce({ topicIds: ["thermal"] }).mockResolvedValueOnce(result);
  expect(await run()).toMatchObject({ topicId: null, state: "done" });
});
it.each(["shortlist", "final"]) ("rejects a forged topic ID at the %s stage", async stage => {
  f.model.mockReset();
  if (stage === "shortlist") f.model.mockResolvedValueOnce({ topicIds: ["foreign-family-topic"] });
  else f.model.mockResolvedValueOnce({ topicIds: ["thermal"] }).mockResolvedValueOnce({ ...answer, topicId: "foreign-family-topic" });
  expect(await run()).toMatchObject({ state: "failed", topicId: null });
});
it("caches budget/provider failures and never repeats an uncertain paid request on refresh", async () => {
  f.model.mockReset().mockRejectedValue(Error("PRIVATE_PROVIDER_BODY"));
  const result = await run(); expect(result).toMatchObject({ state: "failed", topicId: null }); expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  await run(); expect(f.model).toHaveBeenCalledTimes(1);
});
it("does not invent source content if the reader cannot supply the lesson", async () => {
  f.source.mockRejectedValue(Error("missing")); expect(await run()).toMatchObject({ state: "done", topicId: null });
});

it("returns multiple grounded lessons when together they cover the teacher topic", async () => {
  f.model.mockReset().mockResolvedValueOnce({ topicIds: ["thermal", "another"] }).mockResolvedValueOnce({ ...answer, additionalMatches: [{ ...answer, topicId: "another", reason: "Друга частина теми" }] });
  const result = await run(); expect(result.topicId).toBeNull(); expect(result.matches?.map(item => item.topicId)).toEqual(["thermal", "another"]);
});
