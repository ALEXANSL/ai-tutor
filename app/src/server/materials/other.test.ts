import { describe, expect, it, vi } from "vitest";

/**
 * US-23.1 (E-23, D-105): the visibility criterion (КП-1, КП-2, КП-6) is the
 * whole point of this module — every filter is applied server side by the
 * mock query chain below, so these tests confirm the SQL-shaped filters
 * (`.eq`/`.neq`/`.is`) are actually called with the right values, and that
 * the post-fetch `material_topic_links` exclusion (КП-2, not expressible as
 * a single `.eq`) really removes a linked material.
 */
interface Call {
  method: string;
  args: unknown[];
}

function chain(table: string, result: unknown, calls: Call[]) {
  const self = {
    eq: (...a: unknown[]) => {
      calls.push({ method: "eq", args: [table, ...a] });
      return self;
    },
    neq: (...a: unknown[]) => {
      calls.push({ method: "neq", args: [table, ...a] });
      return self;
    },
    is: (...a: unknown[]) => {
      calls.push({ method: "is", args: [table, ...a] });
      return self;
    },
    in: (...a: unknown[]) => {
      calls.push({ method: "in", args: [table, ...a] });
      return self;
    },
    order: () => self,
    limit: () => self,
    maybeSingle: () => Promise.resolve({ data: Array.isArray(result) ? (result[0] ?? null) : result }),
    returns: () => Promise.resolve({ data: result }),
    // `count()` queries are awaited directly (no `.returns()`), so the chain
    // itself must be thenable, resolving to `{ count }`.
    then: (resolve: (v: { count: number }) => void) => resolve({ count: typeof result === "number" ? result : 0 }),
  };
  return self;
}

const materialsRows = [
  { id: "m1", name: "book1.pdf", title: "Клуб «Прототипи»", kind: "other", added_at: "2026-09-27T00:00:00Z" },
  { id: "m2", name: "book2.pdf", title: "Друга книга", kind: "reference", added_at: "2026-09-26T00:00:00Z" },
];

function makeScope(materialsResult: unknown, linksResult: unknown, calls: Call[]) {
  return {
    select: (table: string) => {
      if (table === "materials") return chain(table, materialsResult, calls);
      if (table === "material_topic_links") return chain(table, linksResult, calls);
      return chain(table, [], calls);
    },
    count: (table: string) => chain(table, 0, calls),
  };
}

let scope: ReturnType<typeof makeScope>;
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => scope }));

const { listUnlinkedMaterials, getOtherMaterialDetail } = await import("./other");

describe("listUnlinkedMaterials (US-23.1 КП-1, КП-2, КП-6)", () => {
  it("applies kind<>textbook, status=ready, use_in_lessons=true, subject_id is null", async () => {
    const calls: Call[] = [];
    scope = makeScope(materialsRows, [], calls);
    await listUnlinkedMaterials("fam1");

    expect(calls).toContainEqual({ method: "neq", args: ["materials", "kind", "textbook"] });
    expect(calls).toContainEqual({ method: "eq", args: ["materials", "status", "ready"] });
    expect(calls).toContainEqual({ method: "eq", args: ["materials", "use_in_lessons", true] });
    expect(calls).toContainEqual({ method: "is", args: ["materials", "subject_id", null] });
  });

  it("КП-2: a material with an existing material_topic_links row is excluded even though it passed every materials-table filter", async () => {
    const calls: Call[] = [];
    scope = makeScope(materialsRows, [{ material_id: "m2" }], calls);
    const result = await listUnlinkedMaterials("fam1");

    expect(result.map((r) => r.id)).toEqual(["m1"]);
  });

  it("КП-7: no candidates -> empty array, no material_topic_links query needed", async () => {
    const calls: Call[] = [];
    scope = makeScope([], [], calls);
    const result = await listUnlinkedMaterials("fam1");

    expect(result).toEqual([]);
    expect(calls.some((c) => c.args[0] === "material_topic_links")).toBe(false);
  });
});

describe("getOtherMaterialDetail (US-23.1 КП-2, КП-3, КП-6)", () => {
  const readyMaterial = { id: "m1", name: "book1.pdf", title: "Клуб «Прототипи»", kind: "other", status: "ready", use_in_lessons: true, subject_id: null };

  it("returns chunks in indexed order with section titles resolved", async () => {
    const calls: Call[] = [];
    scope = {
      select: (table: string) => {
        if (table === "materials") return chain(table, readyMaterial, calls);
        if (table === "material_topic_links") return chain(table, null, calls);
        if (table === "chunks") return chain(table, [{ id: "c1", section_id: "s1", page: 12, text: "Розділ 1 текст" }], calls);
        if (table === "material_sections") return chain(table, [{ id: "s1", title: "Розділ 1" }], calls);
        return chain(table, [], calls);
      },
      count: (table: string) => chain(table, 0, calls),
    };
    const detail = await getOtherMaterialDetail("fam1", "m1");

    expect(detail?.chunks).toEqual([{ id: "c1", sectionTitle: "Розділ 1", page: 12, text: "Розділ 1 текст" }]);
    expect(detail?.partiallyIndexed).toBe(false);
  });

  it("BUG report follow-up: drops empty/whitespace-only chunks defensively and flags partiallyIndexed when some scanned pages failed OCR", async () => {
    const calls: Call[] = [];
    scope = {
      select: (table: string) => {
        if (table === "materials") return chain(table, readyMaterial, calls);
        if (table === "material_topic_links") return chain(table, null, calls);
        if (table === "chunks")
          return chain(
            table,
            [
              { id: "c1", section_id: null, page: 1, text: "Текст першої сторінки" },
              { id: "c2", section_id: null, page: 2, text: "   " },
            ],
            calls,
          );
        if (table === "material_sections") return chain(table, [], calls);
        return chain(table, [], calls);
      },
      count: (table: string) => chain(table, table === "material_ocr_pages" ? 3 : 0, calls),
    };
    const detail = await getOtherMaterialDetail("fam1", "m1");

    expect(detail?.chunks).toEqual([{ id: "c1", sectionTitle: null, page: 1, text: "Текст першої сторінки" }]);
    expect(detail?.partiallyIndexed).toBe(true);
  });

  it("КП-2/КП-6: a material that has since been linked to a topic, attached to a subject, or is textbook/not-ready/toggled-off -> null (404 for the caller)", async () => {
    const calls: Call[] = [];
    scope = {
      select: (table: string) => {
        if (table === "materials") return chain(table, readyMaterial, calls);
        if (table === "material_topic_links") return chain(table, { material_id: "m1" }, calls); // now linked
        return chain(table, [], calls);
      },
      count: (table: string) => chain(table, 0, calls),
    };
    expect(await getOtherMaterialDetail("fam1", "m1")).toBeNull();

    scope = {
      select: (table: string) => chain(table, table === "materials" ? { ...readyMaterial, kind: "textbook" } : null, calls),
      count: (table: string) => chain(table, 0, calls),
    };
    expect(await getOtherMaterialDetail("fam1", "m1")).toBeNull();

    scope = {
      select: (table: string) => chain(table, table === "materials" ? { ...readyMaterial, use_in_lessons: false } : null, calls),
      count: (table: string) => chain(table, 0, calls),
    };
    expect(await getOtherMaterialDetail("fam1", "m1")).toBeNull();

    scope = {
      select: (table: string) => chain(table, table === "materials" ? { ...readyMaterial, subject_id: "subj1" } : null, calls),
      count: (table: string) => chain(table, 0, calls),
    };
    expect(await getOtherMaterialDetail("fam1", "m1")).toBeNull();
  });
});
