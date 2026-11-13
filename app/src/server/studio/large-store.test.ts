import { beforeEach, expect, it, vi } from "vitest";
import type { StudioProject } from "@/lib/studio";
import { studioProjectFixture, studioLessonFixture } from "./__fixtures__/project";
interface Row { id: string; family_id: string; type: string; payload: unknown }
const f = vi.hoisted(() => ({ rows: [] as Row[], writes: 0 }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => {
  function query(changes?: { payload: unknown }, filters: [string, unknown][] = []) {
    const value = (row: Row, field: string) => field.startsWith("payload->>") ? String((row.payload as Record<string, unknown>)[field.slice(10)]) : row[field as keyof Row];
    const result = () => f.rows.filter(row => row.family_id === familyId && filters.every(([field, expected]) => Array.isArray(expected) ? expected.includes(value(row, field)) : value(row, field) === expected));
    return { eq: (field: string, expected: unknown) => query(changes, [...filters, [field, expected]]), in: (field: string, expected: unknown[]) => query(changes, [...filters, [field, expected]]), select: () => query(changes, filters), returns: async () => ({ data: structuredClone(result()), error: null }), maybeSingle: async () => { const row = result()[0]; if (row && changes) row.payload = structuredClone(changes.payload); return { data: row ? structuredClone(row) : null, error: null }; } };
  }
  return { select: () => query(), update: (_table: string, changes: { payload: unknown }) => query(changes), upsert: async (_table: string, rows: Omit<Row,"family_id">[]) => { for (const row of rows) { const found = f.rows.find(item => item.id === row.id); if (found && found.family_id !== familyId) throw new Error("cross-family"); if (!found) f.rows.push({ ...structuredClone(row), family_id: familyId }); f.writes++; } return { error: null }; } };
} }));
import { readStudioProject, saveStudioProject } from "./store";
import { studioParentView } from "@/lib/studio-parent-view";
const units = Array.from({ length: 24 }, (_, index) => ({ content: { ...studioLessonFixture, title: `Урок ${index + 1}` }, visuals: [], review: { verdict: "pass" as const, issues: [], summary: "Готово" } }));
beforeEach(() => { f.rows = [{ id: "project", family_id: "family", type: "studio.project", payload: studioProjectFixture({ request: { ...studioProjectFixture().request, lessonCount: 24 }, units }) }]; f.writes = 0; });
it("stores a long course in scoped immutable units and hydrates all content without growing the header", async () => {
  const previous = (await readStudioProject("family", "project"))!;
  await saveStudioProject("family", "project", previous, { state: "ready" });
  const header = f.rows[0]!.payload as StudioProject; expect(header.units).toEqual([]); expect(header.unitRefs).toHaveLength(24); expect(f.writes).toBe(24);
  const full = (await readStudioProject("family", "project"))!; expect(full.units).toEqual(units);
  expect(await readStudioProject("other", "project")).toBeNull();
  const view = studioParentView(full, 17); expect(view.previewIndex).toBe(17); expect(view.units[17]!.content.blocks).toHaveLength(4); expect(view.units[0]!.content.blocks).toEqual([]); expect(view.unitRefs).toBeUndefined(); expect(JSON.stringify(view).length).toBeLessThan(JSON.stringify(full).length / 3);
});
it("writes only a changed lesson and a stale writer cannot overwrite the winning course reference", async () => {
  let project = (await readStudioProject("family", "project"))!; project = await saveStudioProject("family", "project", project, {});
  const stale = structuredClone(project), changed = structuredClone(project.units); changed[17]!.content.title = "Виправлено урок 18";
  const next = await saveStudioProject("family", "project", project, { units: changed }); expect(f.writes).toBe(25); expect(next.unitRefs![0]).toBe(project.unitRefs![0]); expect(next.unitRefs![17]).not.toBe(project.unitRefs![17]);
  await expect(saveStudioProject("family", "project", stale, { state: "published" })).rejects.toThrow();
  expect((await readStudioProject("family", "project"))!.units[17]!.content.title).toBe("Виправлено урок 18");
});
it("refuses missing unit versions instead of returning a truncated or empty course", async () => {
  const previous = (await readStudioProject("family", "project"))!; const next = await saveStudioProject("family", "project", previous, {});
  f.rows = f.rows.filter(row => row.id !== next.unitRefs![8]); await expect(readStudioProject("family", "project")).rejects.toThrow("Не всі матеріали");
});
