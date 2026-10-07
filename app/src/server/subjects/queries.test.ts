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
      in(col: string, vals: unknown[]) {
        filters.push([col, vals]);
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
        return list.filter((r) => filters.every(([c, v]) => (Array.isArray(v) ? v.includes(r[c]) : r[c] === v)));
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

const { effectiveCourseVisible, getSubjectDetail } = await import("./queries");

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

/**
 * S33/D-123 (production bug fix): the old pipeline (`pipeline.ts`) can get a
 * `needs_review` block permanently stuck for paragraph-structured subjects
 * (literature, history, ...) — after `MAX_REVISIONS` failed passes there is
 * no way for it to ever reach `active`. For those topics, an `active`
 * `literature_lessons` row now takes over as the child's entry point
 * instead. `literatureLessonId` is the purely data-driven (no subject name
 * check) flag the child screen branches on.
 */
describe("getSubjectDetail: literatureLessonId (S33/D-123)", () => {
  it("carries the literature_lessons id for a topic that has an ACTIVE row", async () => {
    scopeState.tables = {
      subjects: { id: "subj-lit", code: "lit", name_uk: "Зарубіжна література", active: true, is_stub: false },
      materials: [],
      topics: [{ id: "t1", subject_id: "subj-lit", title: "Розділ 1", page_from: 1, page_to: 10, sort_order: 1, is_current: false }],
      literature_lessons: [{ id: "ll-1", topic_id: "t1", status: "active" }],
    };

    const detail = await getSubjectDetail("fam-1", "subj-lit");

    expect(detail?.topics).toEqual([{ id: "t1", title: "Розділ 1", pageFrom: 1, pageTo: 10, literatureLessonId: "ll-1", courseLessonId: null, mathCourseV2LessonId: null }]);
  });

  it("falls through to the old flow (literatureLessonId: null) when no literature_lessons row exists at all", async () => {
    scopeState.tables = {
      subjects: { id: "subj-math", code: "math", name_uk: "Математика", active: true, is_stub: false },
      materials: [],
      topics: [{ id: "t2", subject_id: "subj-math", title: "Дроби", page_from: 10, page_to: 20, sort_order: 1, is_current: false }],
      literature_lessons: [],
    };

    const detail = await getSubjectDetail("fam-1", "subj-math");

    expect(detail?.topics[0]).toMatchObject({ id: "t2", literatureLessonId: null });
  });

  it("falls through to the old flow (literatureLessonId: null) when the only row for the topic is needs_review", async () => {
    scopeState.tables = {
      subjects: { id: "subj-lit2", code: "lit2", name_uk: "Історія", active: true, is_stub: false },
      materials: [],
      topics: [{ id: "t3", subject_id: "subj-lit2", title: "Розділ 2", page_from: 11, page_to: 20, sort_order: 1, is_current: false }],
      // The DB row exists but hasn't passed content QA yet — must behave
      // exactly like "no row found", never be surfaced to the child
      // (mirrors the RLS policy that blocks the child from reading it at all).
      literature_lessons: [{ id: "ll-2", topic_id: "t3", status: "needs_review" }],
    };

    const detail = await getSubjectDetail("fam-1", "subj-lit2");

    expect(detail?.topics[0]).toMatchObject({ id: "t3", literatureLessonId: null });
  });

  /**
   * 2026-10-02 incident: a course-package import (S34) creates its own
   * fresh `topics` rows rather than attaching to the subject's pre-existing
   * (old-pipeline) ones — so right after importing, the child's topic list
   * mixed the new, working topics in with old, broken ones with no visual
   * distinction ("оперує старими даними", no skip button, no textbook
   * images — the PO had clicked an old one). Once a subject has ANY
   * actively-imported topic, the old ones are filtered out entirely.
   */
  it("hides old (non-imported) topics once the subject has at least one imported topic (S34 incident)", async () => {
    scopeState.tables = {
      subjects: { id: "subj-math2", code: "math2", name_uk: "Математика", active: true, is_stub: false },
      materials: [],
      topics: [
        { id: "old-1", subject_id: "subj-math2", title: "Старий розділ (AI)", page_from: 1, page_to: 5, sort_order: 1, is_current: false },
        { id: "new-1", subject_id: "subj-math2", title: "§ 1. Відсотки", page_from: 10, page_to: 20, sort_order: 2, is_current: false },
      ],
      course_lessons: [{ id: "cl-1", topic_id: "new-1", status: "active" }],
    };

    const detail = await getSubjectDetail("fam-1", "subj-math2");

    expect(detail?.topics.map((t) => t.id)).toEqual(["new-1"]);
  });

  it("keeps every topic when none of them are imported yet (no regression for untouched subjects)", async () => {
    scopeState.tables = {
      subjects: { id: "subj-math3", code: "math3", name_uk: "Математика", active: true, is_stub: false },
      materials: [],
      topics: [
        { id: "a", subject_id: "subj-math3", title: "Тема А", page_from: 1, page_to: 5, sort_order: 1, is_current: false },
        { id: "b", subject_id: "subj-math3", title: "Тема Б", page_from: 6, page_to: 10, sort_order: 2, is_current: false },
      ],
    };

    const detail = await getSubjectDetail("fam-1", "subj-math3");

    expect(detail?.topics.map((t) => t.id)).toEqual(["a", "b"]);
  });
});

/**
 * E-22 (US-22.1/22.2/22.3, ADR-030, VP-52): a school subject stays visible
 * to the child (grey tile) purely by `active`; a course is only reachable
 * when BOTH itself and (if it belongs to one) its group are active.
 */
describe("effectiveCourseVisible (VP-52, US-22.3 КП-3)", () => {
  it("a course with no group only depends on its own active flag", () => {
    expect(effectiveCourseVisible(true, null)).toBe(true);
    expect(effectiveCourseVisible(false, null)).toBe(false);
  });

  it("a course in a group needs both the course and the group active", () => {
    expect(effectiveCourseVisible(true, true)).toBe(true);
    expect(effectiveCourseVisible(true, false)).toBe(false);
    expect(effectiveCourseVisible(false, true)).toBe(false);
  });
});

describe("getSubjectDetail: kind/childVisible (E-22, ADR-030)", () => {
  it("defaults to school_subject / childVisible=active when kind/group_id are absent (pre-E-22 rows)", async () => {
    scopeState.tables = {
      subjects: { id: "s1", code: "math", name_uk: "Математика", active: true, is_stub: false },
      materials: [],
      topics: [],
    };
    const detail = await getSubjectDetail("fam-1", "s1");
    expect(detail).toMatchObject({ kind: "school_subject", groupId: null, groupName: null, childVisible: true });
  });

  it("a school subject stays childVisible=active regardless of any group_id (never has one in practice)", async () => {
    scopeState.tables = {
      subjects: { id: "s2", code: "hist", name_uk: "Історія", active: false, is_stub: false, kind: "school_subject" },
      materials: [],
      topics: [],
    };
    const detail = await getSubjectDetail("fam-1", "s2");
    expect(detail).toMatchObject({ kind: "school_subject", childVisible: false });
  });

  it("a course with no group is childVisible exactly when active", async () => {
    scopeState.tables = {
      subjects: { id: "c1", code: "prompting", name_uk: "Промт-інжиніринг", active: true, is_stub: false, kind: "course", group_id: null },
      materials: [],
      topics: [],
    };
    const detail = await getSubjectDetail("fam-1", "c1");
    expect(detail).toMatchObject({ kind: "course", groupId: null, childVisible: true });
  });

  it("an active course in an INACTIVE group is not childVisible (US-22.3 КП-3)", async () => {
    scopeState.tables = {
      subjects: { id: "c2", code: "robotics", name_uk: "Robotics", active: true, is_stub: false, kind: "course", group_id: "g1" },
      materials: [],
      topics: [],
      course_groups: { id: "g1", name_uk: "Група ІТ", active: false },
    };
    const detail = await getSubjectDetail("fam-1", "c2");
    expect(detail).toMatchObject({ kind: "course", groupId: "g1", groupName: "Група ІТ", childVisible: false });
  });

  it("an active course in an ACTIVE group is childVisible", async () => {
    scopeState.tables = {
      subjects: { id: "c3", code: "robotics2", name_uk: "Robotics 2", active: true, is_stub: false, kind: "course", group_id: "g2" },
      materials: [],
      topics: [],
      course_groups: { id: "g2", name_uk: "Група ІТ", active: true },
    };
    const detail = await getSubjectDetail("fam-1", "c3");
    expect(detail).toMatchObject({ kind: "course", childVisible: true });
  });
});
