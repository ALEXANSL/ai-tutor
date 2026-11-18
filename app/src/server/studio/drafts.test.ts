import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StudioDraftValues } from "./drafts";

const ID = "11111111-1111-4111-8111-111111111111";
const MATERIAL = "22222222-2222-4222-8222-222222222222";
const SUBJECT = "33333333-3333-4333-8333-333333333333";
const TOPIC = "44444444-4444-4444-8444-444444444444";
type Row = { id: string; family_id: string; type: string; status: string; payload: Record<string, unknown>; locked_until: string | null; updated_at: string };
const f = vi.hoisted(() => ({ rows: [] as Row[], operations: [] as { family: string; kind: string; filters: [string, unknown][] }[], start: vi.fn(), readProject: vi.fn(), projects: new Map<string, unknown>(), created: 0, failMark: false }));
vi.mock("./workflow", () => ({ startStudio: f.start }));
vi.mock("./store", () => ({ readStudioProject: f.readProject }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => {
  function query(kind: string, values?: Record<string, unknown>) {
    const filters: [string, unknown][] = [];
    const order: { field: string; asc: boolean }[] = [];
    let limit = Infinity;
    f.operations.push({ family, kind, filters });
    const field = (row: Row, key: string): unknown => key.startsWith("payload->>") ? (row.payload[key.slice(10)] == null ? null : String(row.payload[key.slice(10)])) : row[key as keyof Row];
    const execute = () => {
      if (kind === "insert") {
        if (f.rows.some(row => row.id === values!.id)) return { data: null, error: { code: "23505" } };
        const row = { ...structuredClone(values), family_id: family, locked_until: null, updated_at: new Date().toISOString() } as Row;
        f.rows.push(row); return { data: structuredClone(row), error: null };
      }
      const matches = f.rows.filter(row => row.family_id === family && filters.every(([key, value]) => field(row, key) === value));
      matches.sort((a, b) => { for (const by of order) { const compared = String(field(a, by.field)).localeCompare(String(field(b, by.field))); if (compared) return by.asc ? compared : -compared; } return 0; });
      const selected = matches.slice(0, limit);
      if (kind === "update") {
        if (f.failMark && (values?.payload as Record<string, unknown> | undefined)?.projectId) { f.failMark = false; return { data: null, error: { message: "write failed" } }; }
        for (const row of selected) Object.assign(row, structuredClone(values), { updated_at: new Date().toISOString() });
      }
      return { data: selected[0] ? structuredClone(selected[0]) : null, error: null };
    };
    const self = {
      eq: (key: string, value: unknown) => { filters.push([key, value]); return self; },
      is: (key: string, value: unknown) => { filters.push([key, value]); return self; },
      select: () => self,
      order: (key: string, options?: { ascending: boolean }) => { order.push({ field: key, asc: options?.ascending ?? true }); return self; },
      limit: (cap: number) => { limit = cap; return self; },
      single: async () => execute(), maybeSingle: async () => execute(),
      returns: async () => {
        const matching = f.rows.filter(row => row.family_id === family && filters.every(([key, value]) => field(row, key) === value));
        matching.sort((a, b) => { for (const by of order) { const compared = String(field(a, by.field)).localeCompare(String(field(b, by.field))); if (compared) return by.asc ? compared : -compared; } return 0; });
        return { data: structuredClone(matching.slice(0, limit)), error: null };
      },
      then: (resolve: (value: ReturnType<typeof execute>) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(execute()).then(resolve, reject),
    };
    return self;
  }
  return { select: () => query("select"), insert: (_table: string, values: Record<string, unknown>) => query("insert", values), update: (_table: string, values: Record<string, unknown>) => query("update", values) };
} }));
import { draftValuesSchema, launchStudioFormDraft, listStudioFormDrafts, readStudioFormDraft, saveStudioFormDraft, STUDIO_FORM_DRAFT } from "./drafts";

function values(changes: Partial<StudioDraftValues> = {}): StudioDraftValues {
  return { mode: "course", targetLanguage: null, idea: "Теми з усієї книги", title: "Географія", age: 12, grade: 6, lessonCount: 37, minutes: 20, budgetUsd: 3, subjectId: null, topicId: null, materialId: MATERIAL, pageFrom: null, pageTo: null, sourceText: "Власні нотатки", ...changes };
}
beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-18T10:00:00Z") });
  vi.resetAllMocks(); f.rows = []; f.operations = []; f.projects.clear(); f.created = 0; f.failMark = false;
  f.readProject.mockImplementation(async (family: string, id: string) => f.projects.get(`${family}:${id}`) ?? null);
  f.start.mockImplementation(async (family: string, request: unknown, id: string) => {
    if (!f.projects.has(`${family}:${id}`)) { f.projects.set(`${family}:${id}`, { request }); f.created++; }
    return id;
  });
});
afterEach(() => vi.useRealTimers());

it("persists an incomplete form without loading sources or starting a project", async () => {
  const incomplete = values({ title: "", idea: "  \n", age: 0, grade: 0, lessonCount: 0, minutes: 0, budgetUsd: 0, pageFrom: 9, pageTo: 2 });
  const saved = await saveStudioFormDraft("own", ID, null, incomplete);
  expect(saved).toMatchObject({ id: ID, revision: 0, values: incomplete, projectId: null });
  expect(f.rows[0]).toMatchObject({ family_id: "own", type: STUDIO_FORM_DRAFT, status: "done" });
  expect(Object.keys(f.rows[0]!.payload).sort()).toEqual(["createdAt", "projectId", "revision", "updatedAt", "values", "version"]);
  expect(f.start).not.toHaveBeenCalled(); expect(f.readProject).not.toHaveBeenCalled();
  expect((await readStudioFormDraft("own", ID))!.values).toEqual(incomplete);
});
it("preserves nullable partial ranges and raw hidden selections when saving", async () => {
  const raw = values({ mode: "extension", lessonCount: 80, subjectId: SUBJECT, topicId: TOPIC, pageFrom: null, pageTo: 8 });
  expect((await saveStudioFormDraft("own", ID, null, raw)).values).toEqual(raw);
  expect(draftValuesSchema.safeParse({ ...raw, pageFrom: 9, pageTo: 3 }).success).toBe(true);
});
it.each([{ title: "x".repeat(201) }, { sourceText: "x".repeat(40001) }, { age: Infinity }, { lessonCount: NaN }, { budgetUsd: 251 }, { pageFrom: Infinity }, { subjectId: "invalid" }, { unexpected: "not stored" }])("rejects unbounded, nonfinite or extra draft data %j", async (change) => {
  await expect(saveStudioFormDraft("own", ID, null, { ...values(), ...change })).rejects.toThrow();
  expect(f.rows).toHaveLength(0); expect(f.start).not.toHaveBeenCalled();
});
it("retries creation idempotently and refuses a different request under the same id", async () => {
  const first = await saveStudioFormDraft("own", ID, null, values());
  expect(await saveStudioFormDraft("own", ID, null, values())).toEqual(first);
  await expect(saveStudioFormDraft("own", ID, null, values({ title: "Інша" }))).rejects.toThrow("вже змінено");
  expect(f.rows).toHaveLength(1); expect(f.start).not.toHaveBeenCalled();
});
it("never reads or changes another family's form and does not replace a different job type", async () => {
  await saveStudioFormDraft("other", ID, null, values());
  expect(await readStudioFormDraft("own", ID)).toBeNull(); expect(await listStudioFormDrafts("own")).toEqual([]);
  await expect(saveStudioFormDraft("own", ID, null, values())).rejects.toThrow("вже змінено");
  await expect(saveStudioFormDraft("own", ID, 0, values())).rejects.toThrow("вже змінено");
  await expect(launchStudioFormDraft("own", ID, 0)).rejects.toThrow("вже змінено");
  f.rows[0]!.type = "studio.project"; expect(await readStudioFormDraft("other", ID)).toBeNull();
  expect(f.rows[0]!.family_id).toBe("other"); expect(f.start).not.toHaveBeenCalled();
});
it("allows one CAS edit, preserving createdAt and rejecting a concurrent old revision", async () => {
  const first = await saveStudioFormDraft("own", ID, null, values()); vi.advanceTimersByTime(1000);
  const saved = await saveStudioFormDraft("own", ID, 0, values({ title: "Оновлена" }));
  expect(saved.revision).toBe(1); expect(saved.createdAt).toBe(first.createdAt); expect(saved.updatedAt).not.toBe(first.updatedAt);
  await expect(saveStudioFormDraft("own", ID, 0, values({ title: "Запізніла" }))).rejects.toThrow("вже змінено");
  expect((await readStudioFormDraft("own", ID))!.values.title).toBe("Оновлена");
  expect(f.start).not.toHaveBeenCalled();
});
it("allows exactly one of two concurrent edits of the same revision", async () => {
  await saveStudioFormDraft("own", ID, null, values());
  const outcomes = await Promise.allSettled([
    saveStudioFormDraft("own", ID, 0, values({ title: "First edit" })),
    saveStudioFormDraft("own", ID, 0, values({ title: "Second edit" })),
  ]);
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(result => result.status === "rejected")).toHaveLength(1);
  expect((await readStudioFormDraft("own", ID))!.revision).toBe(1);
  expect(f.start).not.toHaveBeenCalled();
});
it("never launches over a concurrent save of newer form values", async () => {
  await saveStudioFormDraft("own", ID, null, values());
  const [save, launch] = await Promise.allSettled([
    saveStudioFormDraft("own", ID, 0, values({ title: "New version" })),
    launchStudioFormDraft("own", ID, 0),
  ]);
  if (launch.status === "fulfilled") {
    expect(save.status).toBe("rejected"); expect(f.start.mock.calls[0]![1].title).toBe("Географія");
  } else {
    expect(save.status).toBe("fulfilled"); expect(f.start).not.toHaveBeenCalled();
  }
});
it("lists at most 50 owned saved forms in recent order without starting work", async () => {
  const saved = await saveStudioFormDraft("own", ID, null, values());
  for (let i = 0; i < 55; i++) f.rows.push({ ...structuredClone(f.rows[0]!), id: `record-${i}`, updated_at: new Date(Date.parse(saved.updatedAt) + (i + 1) * 1000).toISOString() });
  const found = await listStudioFormDrafts("own"); expect(found).toHaveLength(50); expect(found[0]!.id).toBe("record-54");
  expect(f.start).not.toHaveBeenCalled();
});
it("validates a complete request only on launch; an invalid range remains editable", async () => {
  await saveStudioFormDraft("own", ID, null, values({ pageFrom: 9, pageTo: 2 }));
  await expect(launchStudioFormDraft("own", ID, 0)).rejects.toThrow(); expect(f.start).not.toHaveBeenCalled();
  expect(f.rows[0]!.locked_until).toBeNull(); expect((await readStudioFormDraft("own", ID))!.values.pageFrom).toBe(9);
  await expect(saveStudioFormDraft("own", ID, 0, values({ pageFrom: 2, pageTo: 9 }))).resolves.toMatchObject({ revision: 1 });
});
it("launches one deterministic project explicitly and links it while preserving raw form values", async () => {
  const raw = values({ mode: "extension", subjectId: SUBJECT, topicId: TOPIC, lessonCount: 80 });
  await saveStudioFormDraft("own", ID, null, raw);
  const projectId = await launchStudioFormDraft("own", ID, 0);
  expect(projectId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
  expect(f.start).toHaveBeenCalledWith("own", expect.objectContaining({ mode: "extension", lessonCount: 1, topicId: TOPIC }), projectId);
  expect((await readStudioFormDraft("own", ID))).toMatchObject({ projectId, revision: 1, values: raw });
  expect(await launchStudioFormDraft("own", ID, 0)).toBe(projectId); expect(await launchStudioFormDraft("own", ID, 1)).toBe(projectId);
  expect(f.start).toHaveBeenCalledOnce(); await expect(saveStudioFormDraft("own", ID, 1, values())).rejects.toThrow("вже змінено");
});
it("does not accept a launch revision from before a newer saved edit, even after that newer form launches", async () => {
  await saveStudioFormDraft("own", ID, null, values());
  await saveStudioFormDraft("own", ID, 0, values({ title: "Newer draft" }));
  await launchStudioFormDraft("own", ID, 1);
  await expect(launchStudioFormDraft("own", ID, 0)).rejects.toThrow("вже змінено");
  expect(f.start).toHaveBeenCalledOnce();
});
it("keeps the full course count and clears only its unused topic selector at launch", async () => {
  await saveStudioFormDraft("own", ID, null, values({ lessonCount: 80, topicId: TOPIC }));
  await launchStudioFormDraft("own", ID, 0);
  expect(f.start.mock.calls[0]![1]).toMatchObject({ lessonCount: 80, topicId: null });
  expect((await readStudioFormDraft("own", ID))!.values.topicId).toBe(TOPIC);
});
it("retains an editable form when starting fails before project creation", async () => {
  await saveStudioFormDraft("own", ID, null, values()); f.start.mockRejectedValueOnce(new Error("source not ready"));
  await expect(launchStudioFormDraft("own", ID, 0)).rejects.toThrow("source not ready");
  expect(f.rows[0]!.locked_until).toBeNull(); expect((await readStudioFormDraft("own", ID))).toMatchObject({ revision: 0, projectId: null, values: values() });
  await expect(saveStudioFormDraft("own", ID, 0, values({ materialId: null }))).resolves.toMatchObject({ revision: 1 });
});
it("does not duplicate a durable project when saving the link fails and the launch is retried", async () => {
  await saveStudioFormDraft("own", ID, null, values()); f.failMark = true;
  await expect(launchStudioFormDraft("own", ID, 0)).rejects.toThrow("вже змінено");
  const projectId = f.start.mock.calls[0]![2];
  await expect(saveStudioFormDraft("own", ID, 0, values({ title: "Changed after creation" }))).rejects.toThrow("вже змінено");
  expect(await launchStudioFormDraft("own", ID, 0)).toBe(projectId); expect(f.created).toBe(1);
  expect(f.start.mock.calls.map(call => call[2])).toEqual([projectId, projectId]);
});
it("locks the exact revision while launching, blocking edits and duplicate clicks", async () => {
  await saveStudioFormDraft("own", ID, null, values());
  let finish!: (id: string) => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.start.mockImplementationOnce(async (_family, _request, id) => { entered(); return new Promise<string>(resolve => { finish = () => resolve(id); }); });
  const launching = launchStudioFormDraft("own", ID, 0); await started;
  await expect(saveStudioFormDraft("own", ID, 0, values({ title: "Race" }))).rejects.toThrow("вже змінено");
  await expect(launchStudioFormDraft("own", ID, 0)).rejects.toThrow("вже змінено");
  expect(f.start).toHaveBeenCalledOnce(); finish(ID); await launching;
});
it("an old holder's failure never clears a replacement lease", async () => {
  await saveStudioFormDraft("own", ID, null, values());
  const replacementLease = "2026-11-18T10:30:00.000Z";
  f.start.mockImplementationOnce(async () => { f.rows[0]!.locked_until = replacementLease; throw new Error("old invocation failed"); });
  await expect(launchStudioFormDraft("own", ID, 0)).rejects.toThrow("old invocation failed");
  expect(f.rows[0]!.locked_until).toBe(replacementLease);
});
it("recovers an expired launch with the same deterministic project while keeping stale edits blocked", async () => {
  await saveStudioFormDraft("own", ID, null, values());
  f.rows[0]!.locked_until = "2026-11-18T09:59:00Z";
  await expect(saveStudioFormDraft("own", ID, 0, values({ title: "Cannot race expired launch" }))).rejects.toThrow();
  const id = await launchStudioFormDraft("own", ID, 0);
  expect((await readStudioFormDraft("own", ID))!.projectId).toBe(id);
});
