import { beforeEach, expect, it, vi } from "vitest";
import { studioProjectFixture } from "./__fixtures__/project";
const f = vi.hoisted(() => ({ subject: vi.fn(), read: vi.fn(), rows: new Map<string, Record<string, unknown>[]>(), filters: [] as unknown[] }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.subject }));
vi.mock("./store", () => ({ STUDIO_PROJECT: "studio.project", readStudioProject: f.read }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => ({ select: (table: string, columns: string) => {
  const filters: [string, unknown][] = []; f.filters.push([family, table, columns]);
  const get = () => (f.rows.get(table) ?? []).filter(row => filters.every(([key, value]) => key.startsWith("payload") ? true : row[key] === value));
  const map = () => get().map(row => {
    if (!columns.includes("requestTitle")) return row;
    const value = row.payload as ReturnType<typeof studioProjectFixture>;
    return { id: row.id, title: value.plan?.title, requestTitle: value.request.title, mode: value.request.mode, baseTopicId: value.request.topicId, baseHref: value.baseHref, publication: value.publication };
  });
  const chain = { eq: (field: string, value: unknown) => { filters.push([field, value]); f.filters.push([family, field, value]); return chain; }, order: () => chain, limit: () => chain, range: () => chain, maybeSingle: async () => ({ data: map()[0] ?? null, error: null }), returns: async () => ({ data: map(), error: null }) }; return chain;
} }) }));
import { studioLinksForPath } from "./links";
const baseId = "11111111-1111-4111-8111-111111111111", generatedId = "22222222-2222-4222-8222-222222222222", projectId = "33333333-3333-4333-8333-333333333333";
beforeEach(() => { vi.clearAllMocks(); f.filters = []; f.rows.clear(); f.subject.mockResolvedValue({ childVisible: true }); f.rows.set("literature_v3_lessons", [{ id: baseId, subject_id: "subject", topic_id: "base-topic", package_id: "package", status: "active" }]); f.rows.set("literature_v3_packages", [{ id: "package", package_key: "base-book" }]); f.rows.set("jobs", [{ id: projectId, type: "studio.project", payload: studioProjectFixture({ state: "published", request: { ...studioProjectFixture().request, mode: "extension", subjectId: "subject", topicId: "base-topic" }, baseHref: `/literature-v3/${baseId}`, publication: { subjectId: "subject", packageId: "new", lessons: [{ id: generatedId, topicId: "extension-topic", title: "Поглиблення" }] } }) }]); });
it("connects a base lesson to a published extension without exposing prompts, sources or answer keys", async () => {
  const result = await studioLinksForPath("family", `/literature-v3/${baseId}`); expect(result).toEqual({ back: null, links: [{ title: "Поглиблення", href: `/literature-v3/${generatedId}` }] }); expect(JSON.stringify(result)).not.toContain("correctIndex"); expect(JSON.stringify(result)).not.toContain("sources");
});
it("returns to the exact trusted base lesson from an extension and checks current subject visibility", async () => {
  f.rows.set("literature_v3_lessons", [{ id: generatedId, subject_id: "subject", topic_id: "extension-topic", package_id: "new", status: "active" }]); f.rows.set("literature_v3_packages", [{ id: "new", package_key: `studio.${projectId}` }]); f.read.mockResolvedValue((f.rows.get("jobs")![0]!.payload));
  expect((await studioLinksForPath("family", `/literature-v3/${generatedId}`)).back).toBe(`/literature-v3/${baseId}`);
  f.subject.mockResolvedValue({ childVisible: false }); expect((await studioLinksForPath("family", `/literature-v3/${generatedId}`)).back).toBeNull();
});
it("ignores arbitrary paths and does not query a nonexistent package column on the legacy literature reader", async () => {
  expect(await studioLinksForPath("family", "https://other.invalid/lesson")).toEqual({ back: null, links: [] }); expect(f.filters).toEqual([]);
  f.rows.set("literature_lessons", [{ id: baseId, subject_id: "subject", topic_id: "base-topic", status: "active" }]); await studioLinksForPath("family", `/literature/${baseId}`);
  expect(f.filters).toContainEqual(["family", "literature_lessons", "subject_id,topic_id,status"]);
});
