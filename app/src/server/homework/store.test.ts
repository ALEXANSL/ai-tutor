import { beforeEach, expect, it, vi } from "vitest";
import { homeworkFixture } from "./__fixtures__/work";
import type { HomeworkWork } from "@/lib/homework";
const f = vi.hoisted(() => ({ rows: [] as { id: string; family: string; type: string; payload: HomeworkWork }[] }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  function query(update?: { payload: HomeworkWork }, filters: [string, unknown][] = []) {
    const get = () => f.rows.find(row => row.family === family && filters.every(([key, value]) => key === "payload->>childId" ? row.payload.childId === value : key === "payload->>revision" ? String(row.payload.revision) === value : row[key as "id" | "type"] === value));
    const chain = { eq: (key: string, value: unknown) => query(update, [...filters, [key, value]]), select: () => query(update, filters), maybeSingle: async () => { const row = get(); if (row && update) row.payload = update.payload; return { data: row ?? null, error: null }; } }; return chain;
  }
  return { select: () => query(), update: (_table: string, value: { payload: HomeworkWork }) => query(value) };
} }));
import { readHomework, saveHomework } from "./store";
beforeEach(() => { f.rows = [{ id: "work", family: "family", type: "homework.work", payload: homeworkFixture() }]; });
it("keeps work scoped to both the authenticated family and child", async () => {
  expect(await readHomework("other-family", "child", "work")).toBeNull();
  expect(await readHomework("family", "other-child", "work")).toBeNull();
  await expect(saveHomework("other-family", "work", homeworkFixture(), { state: "running" })).rejects.toThrow();
});
it("accepts only one concurrent revision and excludes documents of other job types", async () => {
  const work = (await readHomework("family", "child", "work"))!;
  await saveHomework("family", "work", work, { state: "running" });
  await expect(saveHomework("family", "work", work, { state: "running" })).rejects.toThrow("вже змінено");
  f.rows[0]!.type = "studio.project"; expect(await readHomework("family", "child", "work")).toBeNull();
});
