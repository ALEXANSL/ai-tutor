import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>[]>() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => ({ select: (table: string) => {
  const filters: ((row: Record<string, unknown>) => boolean)[] = [];
  const rows = () => (fixture.rows.get(table) ?? []).filter(row => filters.every(filter => filter(row)));
  const chain = {
    eq: (field: string, value: unknown) => { filters.push(row => {
      if (field === "literature_v3_works.package_id") return fixture.rows.get("literature_v3_works")?.find(work => work.id === row.work_id)?.package_id === value;
      return row[field] === value;
    }); return chain; },
    in: (field: string, values: unknown[]) => { filters.push(row => values.includes(row[field])); return chain; },
    maybeSingle: async () => ({ data: rows()[0] ?? null }),
    returns: async () => ({ data: rows() }),
  };
  return chain;
} }) }));
import { getLiteratureV3LessonView } from "./literatureV3View";
it("never mixes reading/biography keys reused by another package in the same family", async () => {
  fixture.rows.set("literature_v3_lessons", [{ id: "lesson", package_id: "selected", flow: [{ kind: "reading", ref_id: "R001" }, { kind: "biography", ref_id: "B001" }] }]);
  fixture.rows.set("literature_v3_packages", [{ id: "selected", title: "Selected course" }]);
  fixture.rows.set("literature_v3_reading_items", [
    { id: "own-reading", reading_key: "R001", content_display: "Selected text", work_id: "work1" },
    { id: "other-reading", reading_key: "R001", content_display: "WRONG COURSE TEXT", work_id: "work2" },
  ]);
  fixture.rows.set("literature_v3_biographies", [
    { id: "own-biography", package_id: "selected", biography_key: "B001", content_display: "Selected biography" },
    { id: "other-biography", package_id: "other", biography_key: "B001", content_display: "WRONG BIOGRAPHY" },
  ]);
  fixture.rows.set("literature_v3_works", [{ id: "work1", package_id: "selected", title: "Own work", author: "Own author" }, { id: "work2", package_id: "other", title: "WRONG WORK", author: "WRONG AUTHOR" }]);
  const view = await getLiteratureV3LessonView("family", "lesson", { includeIllustrations: false });
  expect(view?.flow.map(step => step.id)).toEqual(["own-reading", "own-biography"]);
  expect(JSON.stringify(view)).not.toContain("WRONG");
});

it("hides staged or withdrawn Studio lessons, including direct reader calls", async () => {
  fixture.rows.set("literature_v3_lessons", [{ id: "staged", package_id: "studio", flow: [], status: "needs_review" }]);
  fixture.rows.set("literature_v3_packages", [{ id: "studio", title: "Draft", package_key: "studio.project" }]);
  expect(await getLiteratureV3LessonView("family", "staged")).toBeNull();
});
