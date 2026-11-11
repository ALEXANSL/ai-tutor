import { beforeEach, expect, it, vi } from "vitest";
import { studioProjectFixture } from "./__fixtures__/project";
import type { StudioProject } from "@/lib/studio";
const f = vi.hoisted(() => ({ rows: [] as { id: string; family_id: string; type: string; payload: StudioProject }[], reads: [] as string[] }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => {
  function query(values?: { payload: StudioProject }, filters: [string, unknown][] = []) {
    const result = () => f.rows.filter(row => row.family_id === familyId && filters.every(([field, value]) => field === "payload->>revision" ? String(row.payload.revision) === value : row[field as keyof typeof row] === value));
    return { eq: (field: string, value: unknown) => query(values, [...filters, [field, value]]), select: () => query(values, filters), maybeSingle: async () => { f.reads.push(familyId); const row = result()[0]; if (row && values) row.payload = values.payload; return { data: row ? structuredClone(row) : null, error: null }; } };
  }
  return { select: () => query(), update: (_table: string, values: { payload: StudioProject }) => query(values) };
} }));
import { readStudioProject, saveStudioProject } from "./store";
beforeEach(() => { f.rows = [{ id: "project", family_id: "family-a", type: "studio.project", payload: studioProjectFixture() }]; f.reads = []; });
it("never reads or changes another family's draft", async () => {
  expect(await readStudioProject("family-b", "project")).toBeNull();
  await expect(saveStudioProject("family-b", "project", studioProjectFixture(), { state: "published" })).rejects.toThrow();
  expect(f.rows[0]!.payload.state).toBe("planning");
});
it("allows exactly one update of a given revision and returns only matching project types", async () => {
  const previous = (await readStudioProject("family-a", "project"))!;
  const next = await saveStudioProject("family-a", "project", previous, { state: "plan_ready" }); expect(next.revision).toBe(1);
  await expect(saveStudioProject("family-a", "project", previous, { state: "published" })).rejects.toThrow();
  f.rows[0]!.type = "different.job"; expect(await readStudioProject("family-a", "project")).toBeNull();
});
