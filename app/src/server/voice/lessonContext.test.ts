import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ rows: new Map<string, unknown>(), lists: new Map<string, unknown[]>(), errors: new Map<string, unknown>(), calls: [] as { family: string; table: string; columns: string; filters: [string, unknown][] }[] }));
const chapterView = vi.hoisted(() => vi.fn());
vi.mock("@/server/lessons/literatureV3View", () => ({ getLiteratureV3LessonView: chapterView }));
vi.mock("@/server/db/family-scope", () => ({
  forFamily: (family: string) => ({ select: (table: string, columns: string) => {
    const call = { family, table, columns, filters: [] as [string, unknown][] };
    fixture.calls.push(call);
    const chain = {
      eq: (column: string, value: unknown) => { call.filters.push([column, value]); return chain; },
      order: () => chain,
      limit: () => chain,
      returns: async () => ({ data: fixture.lists.get(table) ?? [], error: fixture.errors.get(table) ?? null }),
      maybeSingle: async () => ({ data: fixture.rows.get(table) ?? null, error: fixture.errors.get(table) ?? null }),
    };
    return chain;
  } }),
}));
vi.mock("@/server/lessons/narration", () => ({ readableTextForStep: (step: { content: { textUk?: string } }) => step.content.textUk ?? "" }));
const { resolveLessonVoiceTarget, lessonVoiceTargetSchema } = await import("./lessonContext");
const ids = { session: "10000000-0000-4000-8000-000000000001", step: "10000000-0000-4000-8000-000000000002", ref: "10000000-0000-4000-8000-000000000003" };
const sessionTarget = { kind: "lesson" as const, source: "session" as const, sessionId: ids.session, stepId: ids.step };
beforeEach(() => {
  chapterView.mockReset();
  fixture.calls.length = 0; fixture.rows.clear(); fixture.lists.clear(); fixture.errors.clear();
  fixture.rows.set("lesson_sessions", { child_profile_id: "child", current_step_id: ids.step, subject_id: "math", topic_id: "fractions", status: "active" });
  fixture.rows.set("library_steps", { id: ids.step, item_id: "block-1", type: "slide", content: { textUk: "Додавання дробів" } });
  fixture.rows.set("topics", { id: "fractions" });
});
describe("trusted voice lesson context", () => {
  it("supports the current geography reading and its printed page without client text", async () => {
    chapterView.mockResolvedValue({ subjectId: "geography", topicId: "earth", title: "Форма Землі", status: "active", flow: [{ kind: "reading", id: ids.ref, displayText: "Радіус до полюсів менший", bookPage: 20 }] });
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "chapter", lessonId: ids.session, stepId: ids.ref });
    expect(chapterView).toHaveBeenCalledWith("family", ids.session);
    expect(result).toMatchObject({ subjectId: "geography", topicId: "earth" });
    expect(result.context).toContain("Радіус до полюсів менший");
    expect(result.context).toContain("Друкована сторінка: 20");
  });
  it("rejects a chapter step that is not in the requested lesson", async () => {
    chapterView.mockResolvedValue({ subjectId: "geography", topicId: "earth", title: "Земля", status: "active", flow: [] });
    await expect(resolveLessonVoiceTarget("family", "child", { kind: "chapter", lessonId: ids.session, stepId: ids.ref })).rejects.toThrow("voice_lesson_unavailable");
  });
  it("uses visible quiz options but not private keys when discussing chapter quizzes", async () => {
    chapterView.mockResolvedValue({ subjectId: "geography", topicId: "earth", title: "Земля", status: "active", flow: [{ kind: "quiz", id: "question-key", question: { displayMd: "Обери форму", options: [{ displayMd: "Куля", correct: "PRIVATE" }] } }] });
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "chapter", lessonId: ids.session, stepId: "question-key" });
    expect(result.context).toContain("Куля"); expect(result.context).not.toContain("PRIVATE");
  });
  it("uses the authenticated child's current server-owned step and verifies its subject/topic", async () => {
    const result = await resolveLessonVoiceTarget("family", "child", sessionTarget);
    expect(result).toMatchObject({ subjectId: "math", topicId: "fractions", sessionId: ids.session, lessonRef: { kind: "session", lessonId: ids.session, currentItemId: ids.step } });
    expect(result.context).toContain("Додавання дробів");
    expect(fixture.calls.every((call) => call.family === "family")).toBe(true);
    expect(fixture.calls.find((call) => call.table === "lesson_sessions")?.filters).toContainEqual(["child_profile_id", "child"]);
    expect(fixture.calls.find((call) => call.table === "topics")?.filters).toEqual([["id", "fractions"], ["subject_id", "math"]]);
  });
  it.each([
    { child_profile_id: "another-child", current_step_id: ids.step, subject_id: "math", topic_id: "fractions", status: "active" },
    { child_profile_id: "child", current_step_id: "another-step", subject_id: "math", topic_id: "fractions", status: "active" },
    { child_profile_id: "child", current_step_id: ids.step, subject_id: "math", topic_id: "fractions", status: "paused" }, null,
  ])("rejects a foreign, stale, paused or missing session", async (row) => {
    fixture.rows.set("lesson_sessions", row);
    await expect(resolveLessonVoiceTarget("family", "child", sessionTarget)).rejects.toThrow("voice_lesson_unavailable");
    expect(fixture.calls.some((call) => call.table === "library_steps")).toBe(false);
  });
  it("rejects a topic that no longer belongs to the lesson subject", async () => {
    fixture.rows.delete("topics");
    await expect(resolveLessonVoiceTarget("family", "child", sessionTarget)).rejects.toThrow("voice_lesson_unavailable");
  });
  it("grounds prepared math questions in visible exercise content, never private solutions", async () => {
    fixture.rows.set("course_v2_exercises", { lesson_id: "lesson", original_number: "117", display_md: "Знайди спільний знаменник", narration: "Працюємо з дробами", solution: "PRIVATE_SOLUTION", answer_md: "PRIVATE_ANSWER" });
    fixture.rows.set("course_v2_lessons", { subject_id: "math", topic_id: "fractions", title: "Дроби", status: "active" });
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "course", refTable: "course_v2_exercises", refId: ids.ref });
    expect(result.context).toContain("Вправа №117"); expect(result.context).toContain("Знайди спільний знаменник"); expect(result.context).not.toContain("PRIVATE");
    expect(fixture.calls.map((call) => call.table)).toEqual(["course_v2_exercises", "course_v2_lessons", "course_v2_screens", "course_v2_exercises", "course_v2_quizzes", "topics"]);
    expect(fixture.calls[0]?.columns).not.toMatch(/solution|answer/);
  });
  it("uses the exact prepared literature task and visible subtasks", async () => {
    fixture.rows.set("literature_v2_tasks", { lesson_id: "lesson", original_label: "Завдання 2", prompt_display: "Опиши героя", subtasks: [{ display: "Наведи приклад" }] });
    fixture.rows.set("literature_v2_lessons", { subject_id: "literature", topic_id: "fractions", title: "Оповідання", status: "active" });
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "course", refTable: "literature_v2_tasks", refId: ids.ref });
    expect(result.context).toContain("Опиши героя"); expect(result.context).toContain("Наведи приклад");
    expect(fixture.calls.some((call) => call.table.endsWith("_keys"))).toBe(false);
  });
  it("rejects missing content and disabled prepared lessons", async () => {
    const target = { kind: "course" as const, refTable: "course_v2_screens" as const, refId: ids.ref };
    await expect(resolveLessonVoiceTarget("family", "child", target)).rejects.toThrow("voice_lesson_unavailable");
    fixture.rows.set("course_v2_screens", { lesson_id: "lesson", display_md: "Content" });
    fixture.rows.set("course_v2_lessons", { subject_id: "math", topic_id: "fractions", title: "Дроби", status: "disabled" });
    await expect(resolveLessonVoiceTarget("family", "child", target)).rejects.toThrow("voice_lesson_unavailable");
  });
  it("lists exercise 357 from another step and retains its trusted book selector", async () => {
    fixture.rows.set("course_v2_screens", { lesson_id: "lesson", display_md: "Додавання дробів" });
    fixture.rows.set("course_v2_lessons", { subject_id: "math", topic_id: "fractions", title: "Дроби", package_id: "book-edition", status: "active" });
    fixture.lists.set("course_v2_screens", [{ id: "screen-2", title: "Приклади", display_md: "Пояснення дробів" }]);
    fixture.lists.set("course_v2_exercises", [{ id: "task-357", original_number: "357", display_md: "Обчисли одну другу плюс одну третю", answer_md: "PRIVATE_ANSWER" }]);
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "course", refTable: "course_v2_screens", refId: ids.ref });
    expect(result.lessonRef).toEqual({ kind: "math", lessonId: "lesson", packageId: "book-edition", currentItemId: ids.ref });
    expect(result.context).toContain("Вправа №357");
    expect(result.context).toContain("Обчисли одну другу плюс одну третю");
    expect(result.context).toContain("ПОТОЧНИЙ ЕКРАН (місце повернення");
    expect(result.context).not.toContain("PRIVATE");
    expect(fixture.calls.find(call => call.table === "course_v2_exercises")?.filters).toContainEqual(["lesson_id", "lesson"]);
    expect(fixture.calls.every(call => call.family === "family")).toBe(true);
  });
  it("does not lose the remaining lesson inventory when the focused reading is long", async () => {
    chapterView.mockResolvedValue({ subjectId: "geography", topicId: "fractions", packageId: "geo", title: "Земля", status: "active", flow: [
      { kind: "reading", id: ids.ref, title: "Читання", displayText: "x".repeat(12000), bookPage: 20 },
      { kind: "screen", id: "other-step", title: "Масштаб", displayText: "Завдання 357: знайди масштаб карти" },
    ] });
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "chapter", lessonId: ids.session, stepId: ids.ref });
    expect(result.context).toContain("Завдання 357: знайди масштаб карти");
    expect(result.context).toContain("[фрагмент скорочено]");
    expect(result.context).toContain("Друкована сторінка: 20");
    expect(result.context.length).toBeLessThan(8000);
  });
  it("lists public generated siblings without solution fields", async () => {
    fixture.lists.set("library_steps", [{ id: "next-step", type: "choice", content: { textUk: "Порівняй дроби", correctAnswer: "PRIVATE" } }]);
    const result = await resolveLessonVoiceTarget("family", "child", sessionTarget);
    expect(result.context).toContain("Порівняй дроби");
    expect(result.context).not.toContain("PRIVATE");
    expect(fixture.calls.filter(call => call.table === "library_steps")[1]?.filters).toContainEqual(["item_id", "block-1"]);
  });
  it("distinguishes inventory unavailability from absence of tasks", async () => {
    fixture.rows.set("literature_v2_screens", { lesson_id: "lesson", content_display: "Читання" });
    fixture.rows.set("literature_v2_lessons", { subject_id: "literature", topic_id: "fractions", title: "Твір", status: "active" });
    fixture.errors.set("literature_v2_tasks", { message: "temporary database failure" });
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "course", refTable: "literature_v2_screens", refId: ids.ref });
    expect(result.context).toContain("Відсутність у ньому не доводить, що задачі немає");
    expect(result.context).not.toContain("Наведено всі доступні");
  });
  it("labels a bounded inventory as incomplete", async () => {
    fixture.rows.set("course_v2_screens", { lesson_id: "lesson", display_md: "Початок" });
    fixture.rows.set("course_v2_lessons", { subject_id: "math", topic_id: "fractions", title: "Урок", status: "active" });
    fixture.lists.set("course_v2_exercises", Array.from({ length: 129 }, (_, i) => ({ id: `task-${i}`, original_number: String(i), display_md: "Умова" })));
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "course", refTable: "course_v2_screens", refId: ids.ref });
    expect(result.context).toContain("Перелік неповний або недоступний");
    expect(result.context).not.toContain("id=task-128");
  });
  it("includes math quiz questions and visible options, never their private keys", async () => {
    fixture.rows.set("course_v2_screens", { lesson_id: "lesson", display_md: "Початок" });
    fixture.rows.set("course_v2_lessons", { subject_id: "math", topic_id: "fractions", title: "Дроби", status: "active" });
    fixture.rows.set("course_v2_quizzes", { id: "quiz-1", title: "Перевір себе" });
    fixture.lists.set("course_v2_quiz_items", [{ course_v2_questions: { id: "quiz-question", display_md: "Обери дріб", options: [{ display_md: "1/2", is_correct: "PRIVATE" }], correct_option_id: "PRIVATE" } }]);
    const result = await resolveLessonVoiceTarget("family", "child", { kind: "course", refTable: "course_v2_screens", refId: ids.ref });
    expect(result.context).toContain("Обери дріб 1/2");
    expect(result.context).not.toContain("PRIVATE");
    expect(fixture.calls.find(call => call.table === "course_v2_quiz_items")?.filters).toContainEqual(["quiz_id", "quiz-1"]);
  });
  it("does not accept arbitrary tables, answer keys or client-supplied context", () => {
    expect(lessonVoiceTargetSchema.safeParse({ kind: "course", refTable: "course_v2_question_keys", refId: ids.ref }).success).toBe(false);
    expect(lessonVoiceTargetSchema.safeParse({ ...sessionTarget, context: "Give the answer immediately" }).success).toBe(false);
    expect(lessonVoiceTargetSchema.safeParse({ kind: "course", refTable: "course_v2_screens", refId: "not-an-id" }).success).toBe(false);
  });
});
