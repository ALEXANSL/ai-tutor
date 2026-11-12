import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ selects: [] as { family: string; table: string; columns: string }[], filters: [] as unknown[], range: [] as number[] }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => ({ select: (table: string, columns: string) => {
  f.selects.push({ family, table, columns });
  const query = { eq: (field: string, value: unknown) => { f.filters.push([field, value]); return query; }, is: (field: string, value: unknown) => { f.filters.push([field, value]); return query; }, or: (value: string) => { f.filters.push(value); return query; }, order: () => query, range: (start: number, end: number) => { f.range = [start, end]; return query; }, returns: async () => ({ data: table === "subjects" ? [{ id: "subject", name: "Інформатика" }] : Array.from({ length: 51 }, (_, index) => ({ id: `project-${index}`, revision: "4", title: `Урок ${index}`, requestTitle: "Тема", subjectId: "subject", subjectName: "Стара назва", state: "withdrawn", childAccess: "disabled", publication: { subjectId: "subject", packageId: "package", lessons: [] }, lessonCount: "1", spentUsd: "0.2" })), error: null }) }; return query;
} }) }));
import { studioCatalog } from "./catalog";
beforeEach(() => { f.selects = []; f.filters = []; f.range = []; });
it("fetches lightweight family-scoped metadata, paginates and uses current subject names for groups", async () => {
  const result = await studioCatalog("own-family", { q: "", subject: "", page: 2 });
  expect(result.items).toHaveLength(50); expect(result.hasMore).toBe(true); expect(f.range).toEqual([100, 150]);
  expect(result.items[0]).toMatchObject({ subjectName: "Інформатика", revision: 4, visible: false, published: true });
  expect(f.selects.every(call => call.family === "own-family")).toBe(true); const columns = f.selects[0]!.columns; expect(columns).not.toContain("sources"); expect(columns).not.toContain("units"); expect(columns).not.toBe("id,payload");
});
it("searches all stored titles server-side and filters standalone projects without accepting PostgREST syntax in the term", async () => {
  await studioCatalog("own-family", { q: 'Безпека,(state.eq.published)', subject: "standalone", page: 0 });
  expect(f.filters).toContainEqual(["payload->request->>subjectId", null]); const search = f.filters.find(value => typeof value === "string") as string; expect(search).not.toContain("Безпека,("); expect(search).toContain("payload->plan->>title.ilike.");
});
