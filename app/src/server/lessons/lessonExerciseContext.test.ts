import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>[]>(),
  failures: new Set<string>(),
  calls: [] as { familyId: string; table: string; columns: string; filters: [string, unknown][] }[],
}));
vi.mock("@/server/db/family-scope", () => ({
  forFamily: (familyId: string) => ({
    select: (table: string, columns: string) => {
      if (/keys|solutions|attempts/.test(table)) throw new Error("private data queried");
      const call = { familyId, table, columns, filters: [] as [string, unknown][] };
      fixture.calls.push(call);
      let max = Infinity;
      const filters: ((row: Record<string, unknown>) => boolean)[] = [];
      function response() {
        if (fixture.failures.has(table)) return { data: null, error: { message: "unavailable" } };
        return { data: (fixture.rows.get(table) ?? []).filter(row => row.familyId === familyId && filters.every(filter => filter(row))).slice(0, max), error: null };
      }
      const self = {
        eq: (key: string, value: unknown) => { call.filters.push([key, value]); filters.push(row => row[key] === value); return self; },
        in: (key: string, values: unknown[]) => { call.filters.push([key, values]); filters.push(row => values.includes(row[key])); return self; },
        limit: (value: number) => { max = value; return self; },
        returns: async () => response(),
        maybeSingle: async () => { const result = response(); return { ...result, data: result.data?.[0] ?? null }; },
      };
      return self;
    },
  }),
}));

const { extractLessonExerciseRequest, isLessonExerciseFollowUp, resolveLessonExerciseContext } = await import("./lessonExerciseContext");
const familyId = "family";
const lessonRef = { kind: "math" as const, lessonId: "current", packageId: "book-a", currentItemId: "screen" };
function lesson(id = "current", packageId = "book-a", topicId = "topic") {
  return { familyId, id, title: `Урок ${id}`, subject_id: "math", topic_id: topicId, package_id: packageId, status: "active" };
}
function exercise(id = "task357", lessonId = "current", number = "357") {
  return { familyId, id, lesson_id: lessonId, original_number: number, display_md: `Умова ${id}: обчисли площу прямокутника`, printed_page: 20, private_solution: "SECRET" };
}
beforeEach(() => {
  fixture.rows.clear(); fixture.calls.length = 0; fixture.failures.clear();
  fixture.rows.set("course_v2_lessons", [lesson()]);
  fixture.rows.set("course_v2_exercises", [exercise()]);
});

describe("explicit printed task request recognition", () => {
  it.each(["357", "357?", "Поясни задачу №357", "Поясни 357", "вправа357", "номер 357", "Поясни задачу номер357", "Поясни триста п’ятдесят сім", "номер триста п'ятдесят сім", "Поясни номер триста п’ятдесят сім", "Поясни № триста п’ятдесят сім", "Поясни мені, будь ласка, задачу триста п’ятдесят сім", "розбери вправу триста пʼятдесят сім"])("recognizes %s", text => {
    expect(extractLessonExerciseRequest(text)).toEqual({ number: "357" });
  });
  it("does not truncate longer numbers or conflate subtasks", () => {
    expect(extractLessonExerciseRequest("поясни задачу 3579" )).toEqual({ number: "3579" });
    expect(extractLessonExerciseRequest("задача №357б, сторінка 20" )).toEqual({ number: "357б", page: 20 });
    expect(extractLessonExerciseRequest("Поясни вправу триста п’ятдесят сім пункт б")).toEqual({ number: "357" });
    expect(extractLessonExerciseRequest("3579")).toEqual({ number: "3579" });
  });
  it.each(["Що було у 2024 році?", "Поясни 2024 рік", "поясни 357 плюс 2", "поясни 3,57", "поясни 3.57", "номер двадцять 5", "поясни триста, п’ятдесят сім", "поясни задачу дві тисячі", "поясни задачу одна тисяча триста", "поясни два мільйони", "поясни 2 млн", "я знаю 357", "поясни два три", "поясни сто двісті", "поясни десять два", "№123456", "Поясни вірування народів Сходу"])("does not infer task from %s", text => {
    expect(extractLessonExerciseRequest(text)).toBeNull();
  });
});

describe("explicit continuation of the focused exercise", () => {
  it.each(["А чому?", "Чому тут треба ділити?", "чому треба відняти?", "як це зробити?", "як тут знайти радіус?", "ще раз", "поясни це", "Поясни це ще раз!", "пункт б"])("recognizes %s", text => {
    expect(isLessonExerciseFollowUp(text)).toBe(true);
  });
  it.each(["Повернімося до уроку", "Повернемося до теми", "Розкажи про релігії Сходу", "А чому небо синє?", "Розкажи жарт", "Чому тут цей жарт?", "Скільки планет?", "Що таке буддизм?"])("does not revive an old exercise for %s", text => {
    expect(isLessonExerciseFollowUp(text)).toBe(false);
  });
});

describe("trusted public exercise retrieval", () => {
  it("has no DB work for an ordinary question", async () => {
    expect(await resolveLessonExerciseContext(familyId, "math", "topic", "Розкажи про вірування", lessonRef)).toBeNull();
    expect(fixture.calls).toEqual([]);
  });
  it("retrieves the public condition for another task in the current lesson, not a solution", async () => {
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "Поясни 357", lessonRef);
    expect(context).toContain("found."); expect(context).toContain("Умова task357"); expect(context).not.toContain("SECRET");
    expect(fixture.calls.every(call => call.familyId === familyId)).toBe(true);
    expect(fixture.calls.some(call => /private|solution|correct|answer/.test(call.columns))).toBe(false);
    const call = fixture.calls.find(call => call.table === "course_v2_exercises")!;
    expect(call.filters).toContainEqual(["original_number", "357"]);
    expect(call.filters).toContainEqual(["lesson_id", ["current"]]);
  });
  it("prefers current lesson over another lesson with the same number", async () => {
    fixture.rows.set("course_v2_lessons", [lesson(), lesson("next")]);
    fixture.rows.set("course_v2_exercises", [exercise(), exercise("other357", "next")]);
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "№357", lessonRef);
    expect(context).toContain("Умова task357"); expect(context).not.toContain("Умова other357");
  });
  it("can resolve another lesson of the same book without accidentally reading a second edition", async () => {
    fixture.rows.set("course_v2_lessons", [lesson(), lesson("next"), lesson("other-edition", "book-b")]);
    fixture.rows.set("course_v2_exercises", [exercise("next357", "next"), exercise("edition357", "other-edition")]);
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "№357", lessonRef);
    expect(context).toContain("Умова next357"); expect(context).not.toContain("Умова edition357");
  });
  it("asks for clarification when two non-current lessons have the same number", async () => {
    fixture.rows.set("course_v2_lessons", [lesson(), lesson("a"), lesson("b")]);
    fixture.rows.set("course_v2_exercises", [exercise("a357", "a"), exercise("b357", "b")]);
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "№357", lessonRef);
    expect(context).toContain("ambiguous."); expect(context).not.toContain("Умова a357"); expect(context).not.toContain("Умова b357");
  });
  it("uses a page hint to disambiguate", async () => {
    fixture.rows.set("course_v2_exercises", [exercise(), { ...exercise("second357"), printed_page: 21 }]);
    expect(await resolveLessonExerciseContext(familyId, "math", "topic", "№357 сторінка 21", lessonRef)).toContain("Умова second357");
  });
  it("uses current item only when it is an exact match in this lesson", async () => {
    fixture.rows.set("course_v2_exercises", [exercise(), exercise("second357")]);
    expect(await resolveLessonExerciseContext(familyId, "math", "topic", "№357", { ...lessonRef, currentItemId: "second357" })).toContain("Умова second357");
  });
  it("does not treat a database outage as a missing task", async () => {
    fixture.failures.add("course_v2_exercises");
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "№357", lessonRef);
    expect(context).toContain("unavailable."); expect(context).not.toContain("not_found.");
  });
  it("does not fall back across subjects or families for a forged lesson selector", async () => {
    fixture.rows.set("course_v2_lessons", [{ ...lesson(), familyId: "other-family" }, { ...lesson(), subject_id: "history" }]);
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "№357", lessonRef);
    expect(context).toContain("unavailable.");
    expect(fixture.calls.some(call => call.table === "course_v2_exercises")).toBe(false);
  });
  it("rejects stale package references instead of silently using a different book", async () => {
    expect(await resolveLessonExerciseContext(familyId, "math", "topic", "№357", { ...lessonRef, packageId: "wrong" })).toContain("unavailable.");
  });
  it("distinguishes no exact match from an unavailable index", async () => {
    fixture.rows.set("course_v2_exercises", [exercise("task3579", "current", "3579")]);
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "№357", lessonRef);
    expect(context).toContain("not_found."); expect(context).not.toContain("Умова task3579");
  });
  it("prioritizes current topic for text chat without a lesson selector", async () => {
    fixture.rows.set("course_v2_lessons", [lesson(), lesson("other-topic", "book-a", "different")]);
    fixture.rows.set("course_v2_exercises", [exercise(), exercise("other357", "other-topic")]);
    expect(await resolveLessonExerciseContext(familyId, "math", "topic", "№357")).toContain("Умова task357");
  });
  it("retrieves numbered public literature labels without equating unrelated internal IDs to printed numbers", async () => {
    fixture.rows.set("literature_v2_lessons", [lesson()]);
    fixture.rows.set("literature_v2_tasks", [
      { familyId, id: "task357", lesson_id: "current", original_label: "Завдання №357", prompt_display: "Порівняй персонажів", printed_page: 20, subtasks: [{ display: "Наведи цитату" }], solution: "SECRET" },
      { familyId, id: "357", lesson_id: "current", original_label: "Порівняння", prompt_display: "WRONG", printed_page: 20 },
    ]);
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "№357", { ...lessonRef, kind: "literature" });
    expect(context).toContain("Порівняй персонажів"); expect(context).toContain("Наведи цитату"); expect(context).not.toContain("SECRET"); expect(context).not.toContain("WRONG");
  });
  it("supports real V2 printed labels such as 1. and 2., without accepting decimal labels", async () => {
    fixture.rows.set("literature_v2_lessons", [lesson()]);
    fixture.rows.set("literature_v2_tasks", [
      { familyId, id: "first", lesson_id: "current", original_label: "1.", prompt_display: "Перша умова", printed_page: 20 },
      { familyId, id: "second", lesson_id: "current", original_label: "2.", prompt_display: "Друга умова", printed_page: 20 },
      { familyId, id: "decimal", lesson_id: "current", original_label: "1.2", prompt_display: "WRONG", printed_page: 20 },
    ]);
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "Поясни завдання 1", { ...lessonRef, kind: "literature" });
    expect(context).toContain("found."); expect(context).toContain("Перша умова"); expect(context).not.toContain("Друга умова"); expect(context).not.toContain("WRONG");
  });
  it("does not claim chapter quiz keys are original exercise numbers", async () => {
    const context = await resolveLessonExerciseContext(familyId, "math", "topic", "№357", { ...lessonRef, kind: "chapter" });
    expect(context).toContain("unavailable."); expect(context).toContain("ID квізу не є номером");
    expect(fixture.calls).toEqual([]);
  });
  it("reports an incomplete index as unavailable instead of a confident absence", async () => {
    fixture.rows.set("course_v2_lessons", Array.from({ length: 201 }, (_, index) => lesson(index ? `lesson${index}` : "current")));
    expect(await resolveLessonExerciseContext(familyId, "math", "topic", "№357", lessonRef)).toContain("unavailable.");
  });
});
