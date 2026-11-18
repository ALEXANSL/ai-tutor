import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioSource } from "@/lib/studio";
interface Row { id: string; family_id: string; type: string; status: string; payload: Record<string, unknown> }
const f = vi.hoisted(() => ({ rows: [] as Row[], writes: [] as { rows: Row[]; options: { ignoreDuplicates?: boolean } }[], reads: [] as { familyId: string; type: string | undefined; ids: string[] }[], failWrite: 0, failRead: false }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (familyId: string) => {
  function query(filters: [string, unknown][] = [], ids: string[] = []) {
    return {
      eq: (field: string, value: unknown) => query([...filters, [field, value]], ids),
      in: (_field: string, values: string[]) => query(filters, values),
      returns: async () => {
        f.reads.push({ familyId, type: filters.find(([key]) => key === "type")?.[1] as string | undefined, ids });
        if (f.failRead) return { data: null, error: { message: "read unavailable" } };
        const data = f.rows.filter(row => row.family_id === familyId && ids.includes(row.id) && filters.every(([field, value]) => field === "payload->>corpusId" ? row.payload.corpusId === value : row[field as keyof Row] === value));
        return { data: structuredClone(data).reverse(), error: null };
      },
    };
  }
  return {
    select: () => query(),
    client: { from: () => ({ upsert: async (rows: Row[], options: { ignoreDuplicates?: boolean }) => {
      f.writes.push({ rows: structuredClone(rows), options });
      if (f.failWrite === f.writes.length) return { error: { message: "write unavailable" } };
      for (const row of rows) {
        const previous = f.rows.find(item => item.id === row.id);
        if (previous) { if (!options.ignoreDuplicates) Object.assign(previous, structuredClone(row)); }
        else f.rows.push(structuredClone(row));
      }
      return { error: null };
    } }) },
  };
} }));
import { packStudioSources, snapshotStudioSources, readStudioSourcePart, writeStudioSourceNote, readStudioSourceNotes, STUDIO_SOURCE_PART_BYTES, type SourceNote } from "./source-corpus";

function source(index: number, text = `Повний матеріал сторінки ${index}`): StudioSource {
  return { id: `chunk-${index}`, title: "Великий підручник", text, page: index, kind: "book", audience: "learner" };
}
function note(fromPart: number, toPart = fromPart): SourceNote {
  return { source: { id: `summary-${fromPart}-${toPart}`, title: "Аналіз частини", text: `Зміст частин ${fromPart}–${toPart}`, page: null, kind: "summary" }, fromPart, toPart };
}
beforeEach(() => { f.rows = []; f.writes = []; f.reads = []; f.failWrite = 0; f.failRead = false; });

describe("lossless Studio source partitioning", () => {
  it("retains all 306 pages of a 474k-character book instead of selecting search snippets", async () => {
    const raw = Array.from({ length: 306 }, (_, i) => source(i + 1, "Український текст підручника. ".repeat(60).slice(0, Math.floor(474000 / 306) + (i < 474000 % 306 ? 1 : 0))));
    const corpus = await snapshotStudioSources("family-a", raw);
    expect(corpus.chunkCount).toBe(306); expect(corpus.characterCount).toBe(474000);
    expect(corpus.characterCount).toBe(raw.reduce((sum, row) => sum + row.text.length, 0));
    expect(corpus.pageFrom).toBe(1); expect(corpus.pageTo).toBe(306); expect(corpus.partCount).toBeGreaterThan(6);
    const restored: StudioSource[] = [];
    for (let i = 0; i < corpus.partCount; i++) restored.push(...await readStudioSourcePart("family-a", corpus, i));
    expect(restored).toEqual(raw);
    expect(f.rows.every(row => row.type === "studio.source_part" && row.family_id === "family-a")).toBe(true);
    expect(f.rows.every(row => Buffer.byteLength(JSON.stringify(row.payload)) <= STUDIO_SOURCE_PART_BYTES)).toBe(true);
  });

  it("splits a single oversized Unicode chunk without cutting surrogate pairs or escaped text", () => {
    const text = '«Дитина 👩🏽‍🚀 вивчає географію»\\\n\t\u0001'.repeat(7000);
    const original: StudioSource = { ...source(1, text), title: "Заголовок", audience: "teacher" };
    const parts = packStudioSources([original]);
    const segments = parts.flat();
    expect(segments.length).toBeGreaterThan(2);
    expect(segments.map(row => row.text).join("")).toBe(text);
    for (const [index, row] of segments.entries()) {
      expect(row.id).toBe(`chunk-1#part-${index + 1}`);
      expect(row).toMatchObject({ title: original.title, page: 1, kind: "book", audience: "teacher" });
      expect(row.text.startsWith("\uFFFD")).toBe(false);
      expect(row.text.endsWith("\uFFFD")).toBe(false);
      expect(/[\uD800-\uDBFF]$/.test(row.text)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(row.text)).toBe(false);
    }
    expect(parts.every(part => part.length <= 200 && Buffer.byteLength(JSON.stringify(part)) < STUDIO_SOURCE_PART_BYTES)).toBe(true);
  });

  it("partitions many short chunks by count and preserves blank/null-page source records", async () => {
    const raw = [source(1, ""), { ...source(2, " \n\t"), page: null }, ...Array.from({ length: 450 }, (_, i) => source(i + 3, "а"))];
    const corpus = await snapshotStudioSources("family-a", raw);
    expect(corpus).toMatchObject({ chunkCount: 452, blankChunks: 2, pageFrom: 1, pageTo: 452 });
    expect(corpus.partCount).toBe(3);
    const restored: StudioSource[] = [];
    for (let i = 0; i < corpus.partCount; i++) restored.push(...await readStudioSourcePart("family-a", corpus, i));
    expect(restored).toEqual(raw);
    const unnumbered = await snapshotStudioSources("family-a", [{ ...source(1), page: null }]);
    expect(unnumbered.pageFrom).toBeNull(); expect(unnumbered.pageTo).toBeNull();
  });

  it("accepts an empty corpus but cannot invent a raw part or analysis range for it", async () => {
    const corpus = await snapshotStudioSources("family-a", []);
    expect(corpus).toMatchObject({ partCount: 0, chunkCount: 0, characterCount: 0, blankChunks: 0, pageFrom: null, pageTo: null });
    await expect(readStudioSourcePart("family-a", corpus, 0)).rejects.toThrow();
    await expect(writeStudioSourceNote("family-a", corpus.id, note(0))).rejects.toThrow();
    expect(f.rows).toEqual([]);
  });

  it("rejects impossible metadata or ambiguous source IDs instead of silently skipping data", () => {
    expect(() => packStudioSources([source(1), source(1)])).toThrow(/фрагменти/);
    expect(() => packStudioSources([{ ...source(1), title: "а".repeat(70000), text: "" }])).toThrow(/завеликий/);
    expect(() => packStudioSources([source(1, "а".repeat(70000)), { ...source(2), id: "chunk-1#part-1" }])).toThrow(/ідентифікатори/);
  });
});

describe("immutable source snapshots", () => {
  it("reuses an identical snapshot, including reordered object keys, while content or family changes its identity", async () => {
    const original = source(1);
    const first = await snapshotStudioSources("family-a", [original]);
    const reordered = { audience: original.audience, page: original.page, text: original.text, title: original.title, kind: original.kind, id: original.id };
    expect(await snapshotStudioSources("family-a", [reordered])).toEqual(first);
    expect(f.rows).toHaveLength(1);
    const changed = await snapshotStudioSources("family-a", [source(1, "Змінений текст")]);
    const otherFamily = await snapshotStudioSources("family-b", [original]);
    expect(changed.id).not.toBe(first.id); expect(otherFamily.id).not.toBe(first.id);
    expect(f.writes.every(write => write.options.ignoreDuplicates)).toBe(true);
  });

  it("refuses another family's snapshot and altered or missing part metadata", async () => {
    const corpus = await snapshotStudioSources("family-a", [source(1)]);
    await expect(readStudioSourcePart("family-b", corpus, 0)).rejects.toThrow(/недоступний/);
    await expect(readStudioSourcePart("family-a", { ...corpus, characterCount: corpus.characterCount + 1 }, 0)).rejects.toThrow(/пошкоджений/);
    await expect(readStudioSourcePart("family-a", corpus, 1)).rejects.toThrow();
    await expect(readStudioSourcePart("family-a", corpus, -1)).rejects.toThrow();
    await expect(readStudioSourcePart("family-a", corpus, 0.5)).rejects.toThrow();
    f.rows = [];
    await expect(readStudioSourcePart("family-a", corpus, 0)).rejects.toThrow(/недоступний/);
  });

  it("reads an immutable part when the workflow descriptor contains mutable analysis progress", async () => {
    const original = source(1);
    const corpus = await snapshotStudioSources("family-a", [original]);
    const active = { ...corpus, analyzed: 0, notes: [], catalog: [], reduceCursor: 0, reduced: [] };
    expect(await readStudioSourcePart("family-a", active, 0)).toEqual([original]);
    const resumed = { ...active, analyzed: 1, notes: ["saved-note"], catalog: ["saved-note"], reduceCursor: 1 };
    expect(await readStudioSourcePart("family-a", resumed, 0)).toEqual([original]);
    await expect(readStudioSourcePart("family-a", { ...resumed, chunkCount: 2 }, 0)).rejects.toThrow(/пошкоджений/);
  });

  it("detects corrupt text and never overwrites a corrupted immutable row during retry", async () => {
    const corpus = await snapshotStudioSources("family-a", [source(1)]);
    const row = f.rows[0]!;
    (row.payload.sources as StudioSource[])[0]!.text = "Зіпсовані дані";
    await expect(readStudioSourcePart("family-a", corpus, 0)).rejects.toThrow(/пошкоджений/);
    await expect(snapshotStudioSources("family-a", [source(1)])).rejects.toThrow(/пошкоджений/);
    expect((row.payload.sources as StudioSource[])[0]!.text).toBe("Зіпсовані дані");
  });

  it("resumes a partial immutable write safely after a real write failure", async () => {
    const raw = Array.from({ length: 10 }, (_, index) => source(index + 1, "а".repeat(25000)));
    f.failWrite = 2;
    await expect(snapshotStudioSources("family-a", raw)).rejects.toThrow(/зберегти повний текст/);
    expect(f.rows).toHaveLength(5);
    f.failWrite = 0;
    const corpus = await snapshotStudioSources("family-a", raw);
    expect(f.rows).toHaveLength(corpus.partCount);
    expect((await readStudioSourcePart("family-a", corpus, corpus.partCount - 1))[0]!.text).toBe(raw.at(-1)!.text);
  });
});

describe("durable source analysis notes", () => {
  it("stores content-addressed notes and returns them in exact reference order despite unordered DB rows", async () => {
    const corpus = await snapshotStudioSources("family-a", Array.from({ length: 450 }, (_, i) => source(i + 1, "Короткий текст")));
    const first = note(0), second = note(1), combined = note(0, 2);
    const refs = [await writeStudioSourceNote("family-a", corpus.id, first), await writeStudioSourceNote("family-a", corpus.id, second), await writeStudioSourceNote("family-a", corpus.id, combined)];
    expect(await writeStudioSourceNote("family-a", corpus.id, first)).toBe(refs[0]);
    expect(await readStudioSourceNotes("family-a", corpus.id, [refs[2]!, refs[0]!, refs[1]!])).toEqual([combined, first, second]);
    expect(f.rows.filter(row => row.type === "studio.source_note")).toHaveLength(3);
    await expect(readStudioSourceNotes("family-b", corpus.id, refs)).rejects.toThrow();
    await expect(readStudioSourceNotes("family-a", corpus.id, [refs[0]!, refs[0]!])).rejects.toThrow();
  });

  it("preserves verified quote provenance exactly without inferring quotes from summaries", async () => {
    const corpus = await snapshotStudioSources("family-a", [source(1, "Точна цитата з підручника.")]);
    const item = { ...note(0), quotes: [{ sourceId: "chunk-1", text: "Точна цитата з підручника." }] };
    const id = await writeStudioSourceNote("family-a", corpus.id, item);
    expect(await readStudioSourceNotes("family-a", corpus.id, [id])).toEqual([item]);
    const invalid = { ...note(0), quotes: [{ sourceId: "", text: "Немає джерела" }] };
    await expect(writeStudioSourceNote("family-a", corpus.id, invalid)).rejects.toThrow();
    const stored = f.rows.find(row => row.id === id)!;
    ((stored.payload.note as SourceNote).quotes![0]!).text = "Переказ, а не цитата";
    await expect(readStudioSourceNotes("family-a", corpus.id, [id])).rejects.toThrow(/пошкоджений/);
  });

  it("reads more than one DB batch without silently dropping trailing notes", async () => {
    const corpus = await snapshotStudioSources("family-a", [source(1)]);
    const notes = Array.from({ length: 12 }, (_, index) => ({ ...note(0), source: { ...note(0).source, id: `note-${index}` } }));
    const refs: string[] = [];
    for (const item of notes) refs.push(await writeStudioSourceNote("family-a", corpus.id, item));
    expect(await readStudioSourceNotes("family-a", corpus.id, refs)).toEqual(notes);
    expect(f.reads.filter(read => read.type === "studio.source_note").every(read => read.ids.length <= 5)).toBe(true);
    f.rows = f.rows.filter(row => row.id !== refs.at(-1));
    await expect(readStudioSourceNotes("family-a", corpus.id, refs)).rejects.toThrow(/недоступний/);
  });

  it("rejects invalid coverage, oversize notes, foreign corpus IDs, corrupted notes and failed reads", async () => {
    const corpus = await snapshotStudioSources("family-a", [source(1)]);
    for (const item of [note(-1), note(0, 1), note(1, 0), { ...note(0), fromPart: 0.5 }]) {
      await expect(writeStudioSourceNote("family-a", corpus.id, item)).rejects.toThrow();
    }
    const oversized = note(0); oversized.source.text = "а".repeat(60000);
    await expect(writeStudioSourceNote("family-a", corpus.id, oversized)).rejects.toThrow(/завеликий/);
    const id = await writeStudioSourceNote("family-a", corpus.id, note(0));
    const other = await snapshotStudioSources("family-a", [source(1, "Інший корпус")]);
    await expect(readStudioSourceNotes("family-a", other.id, [id])).rejects.toThrow();
    const row = f.rows.find(item => item.id === id)!;
    (row.payload.note as SourceNote).source.text = "Інший конспект";
    await expect(readStudioSourceNotes("family-a", corpus.id, [id])).rejects.toThrow(/пошкоджений/);
    f.failRead = true;
    await expect(readStudioSourcePart("family-a", corpus, 0)).rejects.toThrow();
  });
});

it("stores a valid analysis note above the raw-part limit without truncating source text or evidence",async()=>{
 const corpus=await snapshotStudioSources("family-a",[source(1)]);const large=note(0);large.source.text="я".repeat(33000);const id=await writeStudioSourceNote("family-a",corpus.id,large);expect((await readStudioSourceNotes("family-a",corpus.id,[id]))[0]).toEqual(large);expect(f.rows.filter(row=>row.type==="studio.source_part").every(row=>Buffer.byteLength(JSON.stringify(row.payload))<=60000)).toBe(true);
});
