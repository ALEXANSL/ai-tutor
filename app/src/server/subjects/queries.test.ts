import { describe, expect, it, vi } from "vitest";

/**
 * D-65 (docs/01-requirements.md 12.13): the child screen must offer every
 * topic of an active subject's textbook, not only the one marked
 * `is_current` — that flag stays a priority hint for the forecast plan in
 * the parent cabinet (US-3.1/3.2, unmodified). This locks down
 * `getSubjectDetail`'s read model: `topics` carries the whole list in
 * curriculum order, and `currentTopicId` is only a hint alongside it, never
 * a filter.
 */

interface FakeRow {
  [k: string]: unknown;
}

function makeScope(tables: Record<string, FakeRow[] | FakeRow>) {
  function builder(table: string) {
    const filters: [string, unknown][] = [];
    const self = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return self;
      },
      order() {
        return self;
      },
      limit() {
        return self;
      },
      not() {
        return self;
      },
      select() {
        return self;
      },
      matched() {
        const rows = tables[table];
        const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
        return list.filter((r) => filters.every(([c, v]) => r[c] === v));
      },
      maybeSingle: () => Promise.resolve({ data: self.matched()[0] ?? null, error: null }),
      returns: () => Promise.resolve({ data: self.matched(), error: null }),
    };
    return self;
  }
  return { select: (table: string) => builder(table) };
}

const scopeState = { tables: {} as Record<string, FakeRow[] | FakeRow> };
vi.mock("../db/family-scope", () => ({ forFamily: () => makeScope(scopeState.tables) }));

const { getSubjectDetail } = await import("./queries");

describe("getSubjectDetail (D-65)", () => {
  it("returns every topic of the subject, not only the current one", async () => {
    scopeState.tables = {
      subjects: { id: "subj-1", code: "math", name_uk: "Математика", active: true, is_stub: false },
      materials: [],
      topics: [
        { id: "t1", subject_id: "subj-1", title: "Дроби", page_from: 10, page_to: 20, sort_order: 1, is_current: false },
        { id: "t2", subject_id: "subj-1", title: "Відсотки", page_from: 21, page_to: 30, sort_order: 2, is_current: true },
        { id: "t3", subject_id: "subj-1", title: "Пропорції", page_from: 31, page_to: 40, sort_order: 3, is_current: false },
      ],
    };

    const detail = await getSubjectDetail("fam-1", "subj-1");

    expect(detail).not.toBeNull();
    expect(detail?.topics.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    // The "current" flag is carried separately as a hint, not used to filter `topics`.
    expect(detail?.currentTopicId).toBe("t2");
  });

  it("keeps currentTopicId null when no topic is marked current, but still lists all topics", async () => {
    scopeState.tables = {
      subjects: { id: "subj-2", code: "ukr", name_uk: "Українська", active: true, is_stub: false },
      materials: [],
      topics: [
        { id: "t4", subject_id: "subj-2", title: "Іменник", page_from: 5, page_to: 8, sort_order: 1, is_current: false },
      ],
    };

    const detail = await getSubjectDetail("fam-1", "subj-2");

    expect(detail?.topics.map((t) => t.id)).toEqual(["t4"]);
    expect(detail?.currentTopicId).toBeNull();
  });

  it("returns null for a subject not found in this family's scope", async () => {
    scopeState.tables = { subjects: [], materials: [], topics: [] };
    const detail = await getSubjectDetail("fam-1", "missing");
    expect(detail).toBeNull();
  });
});
