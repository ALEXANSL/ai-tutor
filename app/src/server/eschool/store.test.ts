import { beforeEach, expect, it, vi } from "vitest";
import type { SchoolEntry } from "@/lib/eschool";
import { schoolPacketFixture } from "./__fixtures__/packet";
const f = vi.hoisted(() => ({ rows: [] as { id: string; family: string; type: string; payload: SchoolEntry }[] }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  function query(changes?: { payload: SchoolEntry }, filters: [string, unknown][] = []) {
    const get = () => f.rows.find(row => row.family === family && filters.every(([key, value]) => key === "payload->>childId" ? row.payload.childId === value : key === "payload->>revision" ? String(row.payload.revision) === value : row[key as "id" | "type"] === value));
    const chain = { eq: (key: string, value: unknown) => query(changes, [...filters, [key, value]]), select: () => query(changes, filters), maybeSingle: async () => { const row = get(); if (row && changes) row.payload = changes.payload; return { data: row ?? null, error: null }; } }; return chain;
  }
  return { select: () => query(), update: (_table: string, values: { payload: SchoolEntry }) => query(values) };
} }));
import { readSchoolDoc, saveSchoolDoc, schoolId, SCHOOL_ENTRY } from "./store";
let entry: SchoolEntry;
beforeEach(() => { const packet = schoolPacketFixture(); entry = { version: 1, revision: 0, childId: "child", identity: packet.identity, source: packet.entries[1]!, capturedAt: packet.capturedAt, syncedAt: packet.capturedAt, status: "todo", changed: false, subjectId: null, topicId: null, lessonHref: null, workHref: null }; f.rows = [{ id: "entry", family: "family", type: SCHOOL_ENTRY, payload: entry }]; });
it("scopes reads and updates to both family and child and protects concurrent revisions", async () => {
  expect(await readSchoolDoc("other", "child", "entry", SCHOOL_ENTRY)).toBeNull(); expect(await readSchoolDoc("family", "other-child", "entry", SCHOOL_ENTRY)).toBeNull();
  await expect(saveSchoolDoc("other", "entry", SCHOOL_ENTRY, entry, { status: "done" })).rejects.toThrow();
  await saveSchoolDoc("family", "entry", SCHOOL_ENTRY, entry, { status: "done" });
  await expect(saveSchoolDoc("family", "entry", SCHOOL_ENTRY, entry, { status: "working" })).rejects.toThrow(); expect(f.rows[0]!.payload.status).toBe("done");
});
it("creates stable namespaced UUIDs without collisions across families or pupils", () => {
  expect(schoolId("family", "child", "100")).toBe(schoolId("family", "child", "100")); expect(schoolId("family", "child", "100")).not.toBe(schoolId("other", "child", "100")); expect(schoolId("family", "child", "100")).toMatch(/^[a-f0-9-]{36}$/);
});
