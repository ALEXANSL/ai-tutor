import { describe, expect, it, vi } from "vitest";

/**
 * ADR-034: `getOrCreateFallbackBlock` (BUG-011's safe simplified template)
 * used to trust its one candidate fragment blindly — zero verification, the
 * exact gap that let a corrupted excerpt reach the child live. These tests
 * cover the new behaviour: try the next candidate fragment on a `content_qa`
 * failure, mark only the genuinely-verbatim step, and fail honestly (with a
 * parent notification) when every candidate fails.
 *
 * `@/server/db/family-scope` and `@/server/notifications` are mocked — this
 * is a pure wiring test, not a DB test.
 */

const notifyParent = vi.fn().mockResolvedValue(undefined);
vi.mock("@/server/notifications", () => ({ notifyParent: (...args: unknown[]) => notifyParent(...args) }));

interface ChunkRow {
  material_id: string;
  page: number | null;
  text: string;
  materials: { title: string | null; name: string; kind: string };
}

/** A minimal fluent stand-in for the chainable methods `generate.ts` actually calls on `scope`/`scope.client`. */
function fluent(terminal: { returns?: unknown[]; single?: unknown; maybeSingle?: unknown }) {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === "returns") return async () => ({ data: terminal.returns ?? [], error: null });
      if (prop === "single") return async () => ({ data: terminal.single ?? null, error: terminal.single ? null : { message: "no row" } });
      if (prop === "maybeSingle") return async () => ({ data: terminal.maybeSingle ?? null, error: null });
      return () => proxy;
    },
  };
  const proxy = new Proxy({}, handler);
  return proxy as never;
}

let insertedItem: Record<string, unknown> | null = null;
let insertedSteps: Record<string, unknown>[] | null = null;

function makeScope(chunkRows: ChunkRow[]) {
  insertedItem = null;
  insertedSteps = null;
  return {
    // Existing-fallback check + `attachSectionTitles`'s topics/material_sections lookups.
    select: () => fluent({ maybeSingle: null, returns: [] }),
    client: {
      from: (table: string) => {
        if (table === "chunks") return { select: () => fluent({ returns: chunkRows }) };
        if (table === "library_items") {
          return {
            insert: (row: Record<string, unknown>) => {
              insertedItem = row;
              return { select: () => fluent({ single: { id: "item1" } }) };
            },
          };
        }
        if (table === "library_steps") {
          return {
            insert: (rows: Record<string, unknown>[]) => {
              insertedSteps = rows;
              return Promise.resolve({ error: null });
            },
          };
        }
        throw new Error(`generate.test.ts fake scope: unexpected table ${table}`);
      },
    },
  } as never;
}

vi.mock("@/server/db/family-scope", () => ({ forFamily: () => scopeToReturn }));
let scopeToReturn: ReturnType<typeof makeScope>;

const { getOrCreateFallbackBlock, NoValidFragmentsError, NoIndexedFragmentsError } = await import("./generate");

function chunkRow(over: Partial<ChunkRow> = {}): ChunkRow {
  return {
    material_id: "m1",
    page: 12,
    text: "Це повністю нормальний уривок з підручника, який закінчується завершеним реченням.",
    materials: { title: "Підручник математики", name: "math.pdf", kind: "textbook" },
    ...over,
  };
}

describe("getOrCreateFallbackBlock (ADR-034: content_qa verification of the BUG-011 fallback excerpt)", () => {
  it("uses the first fragment as-is when it passes content_qa", async () => {
    scopeToReturn = makeScope([chunkRow()]);
    const result = await getOrCreateFallbackBlock("fam1", "subj1", "topic1", "Дроби", 6);
    expect(result.id).toBe("item1");
    expect(insertedSteps).not.toBeNull();
    const slideStep = insertedSteps!.find((s) => s.type === "slide")!;
    expect((slideStep.content as { textUk: string }).textUk).toContain("нормальний уривок");
  });

  it("skips a fragment that ends mid-clause (dangling preposition) and uses the next one", async () => {
    scopeToReturn = makeScope([
      chunkRow({ material_id: "bad", text: "Незламна воля до" }), // ends on a dangling preposition — looksComplete rejects
      chunkRow({ material_id: "good", text: "Це другий, цілком нормальний і завершений уривок." }),
    ]);
    const result = await getOrCreateFallbackBlock("fam1", "subj1", "topic1", "Тема", 6);
    expect(result.id).toBe("item1");
    const slideStep = insertedSteps!.find((s) => s.type === "slide")!;
    expect((slideStep.content as { textUk: string }).textUk).toContain("другий");
    const sourceRefs = slideStep.source_refs as { materialId: string }[];
    expect(sourceRefs[0]!.materialId).toBe("good");
  });

  it("skips a fragment with the BUG-046 mojibake signature (³/¿ inside a Cyrillic word) and uses the next one", async () => {
    scopeToReturn = makeScope([
      chunkRow({ material_id: "bad", text: "Запрошення до л³тературно¿ мандр³вки." }),
      chunkRow({ material_id: "good", text: "Запрошення до літературної мандрівки." }),
    ]);
    const result = await getOrCreateFallbackBlock("fam1", "subj1", "topic1", "Тема", 6);
    expect(result.id).toBe("item1");
    const slideStep = insertedSteps!.find((s) => s.type === "slide")!;
    expect((slideStep.content as { textUk: string }).textUk).toContain("літературної");
  });

  it("never flags a legitimate cubic-unit token (см³) as BUG-046 mojibake", async () => {
    scopeToReturn = makeScope([chunkRow({ text: "Об'єм становить 5 см³ води в мірному стакані." })]);
    const result = await getOrCreateFallbackBlock("fam1", "subj1", "topic1", "Тема", 6);
    expect(result.id).toBe("item1");
  });

  it("marks only the slide step's source_refs verbatim=true, never the choice step's", async () => {
    scopeToReturn = makeScope([chunkRow()]);
    await getOrCreateFallbackBlock("fam1", "subj1", "topic1", "Тема", 6);
    const slideStep = insertedSteps!.find((s) => s.type === "slide")!;
    const choiceStep = insertedSteps!.find((s) => s.type === "choice")!;
    expect((slideStep.source_refs as { verbatim?: boolean }[])[0]!.verbatim).toBe(true);
    expect((choiceStep.source_refs as { verbatim?: boolean }[])[0]!.verbatim).toBeUndefined();
  });

  it("saves a content_qa=checked_ok summary on the library_item row", async () => {
    scopeToReturn = makeScope([chunkRow()]);
    await getOrCreateFallbackBlock("fam1", "subj1", "topic1", "Тема", 6);
    expect(insertedItem!.content_qa).toMatchObject({ status: "checked_ok", failures: [] });
  });

  it("throws NoValidFragmentsError and notifies the parent when every candidate fragment fails content_qa", async () => {
    notifyParent.mockClear();
    scopeToReturn = makeScope([
      chunkRow({ text: "Обривається на слові і" }),
      chunkRow({ text: "І цей теж обривається на що" }),
    ]);
    await expect(getOrCreateFallbackBlock("fam1", "subj1", "topic1", "Тема", 6)).rejects.toThrow(NoValidFragmentsError);
    expect(insertedItem).toBeNull(); // never silently saved a failing excerpt
    expect(notifyParent).toHaveBeenCalledTimes(1);
    expect(notifyParent.mock.calls[0]![1]).toMatchObject({ type: "fallback_content_qa_failed" });
  });

  it("still throws NoIndexedFragmentsError (unchanged BUG behaviour) when the topic has zero indexed fragments", async () => {
    scopeToReturn = makeScope([]);
    await expect(getOrCreateFallbackBlock("fam1", "subj1", "topic1", "Тема", 6)).rejects.toThrow(NoIndexedFragmentsError);
  });
});
