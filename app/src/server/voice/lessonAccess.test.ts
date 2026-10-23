import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>[]>(), errors: new Set<string>(), calls: [] as { family: string; table: string; columns: string; filters: [string, unknown][] }[] }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => ({ select: (table: string, columns: string) => {
  if (/content|display|narration|solution|correct|answer|asset|storage/i.test(columns + table)) throw new Error("access checks must not hydrate content/media");
  const call = { family, table, columns, filters: [] as [string, unknown][] }; f.calls.push(call);
  const self = {
    eq: (key: string, value: unknown) => { call.filters.push([key, value]); return self; },
    is: (key: string, value: unknown) => { call.filters.push([key, value]); return self; },
    maybeSingle: async () => ({ error: f.errors.has(table) ? { message: "unavailable" } : null,
      data: (f.rows.get(table) ?? []).find(row => row.family === family && call.filters.every(([key, value]) => row[key] === value)) ?? null }),
  }; return self;
} }) }));

const { assertLessonVoiceAccess } = await import("./lessonAccess");
const id = "10000000-0000-4000-8000-000000000001";
const stepId = "10000000-0000-4000-8000-000000000002";
const base = { family: "family", subject_id: "subject", topic_id: "topic", status: "active" };
const chapter = { kind: "chapter" as const, lessonId: id, stepId };
function put(table: string, row: Record<string, unknown>) { f.rows.set(table, [{ family: "family", ...row }]); }
beforeEach(() => {
  f.rows.clear(); f.calls.length = 0; f.errors.clear();
  put("topics", { id: "topic", subject_id: "subject" });
});

describe("lightweight voice authorization", () => {
  it("checks child-owned active sessions and current step without text", async () => {
    put("lesson_sessions", { ...base, id, child_profile_id: "child", current_step_id: stepId });
    put("library_steps", { id: stepId });
    expect(await assertLessonVoiceAccess("family", "child", { kind: "lesson", source: "session", sessionId: id, stepId })).toEqual({ subjectId: "subject", topicId: "topic", sessionId: id });
    expect(f.calls.every(call => call.family === "family")).toBe(true);
    expect(f.calls.find(call => call.table === "lesson_sessions")?.filters).toContainEqual(["child_profile_id", "child"]);
  });
  it.each([
    { child_profile_id: "other", current_step_id: stepId, status: "active" },
    { child_profile_id: "child", current_step_id: "changed", status: "active" },
    { child_profile_id: "child", current_step_id: stepId, status: "paused" },
  ])("rejects foreign, changed or paused session", async row => {
    put("lesson_sessions", { ...base, id, ...row }); put("library_steps", { id: stepId });
    await expect(assertLessonVoiceAccess("family", "child", { kind: "lesson", source: "session", sessionId: id, stepId })).rejects.toThrow("voice_lesson_unavailable");
  });
  it.each(["course_v2_screens", "course_v2_exercises", "literature_v2_screens", "literature_v2_tasks"] as const)("checks imported public item %s", async refTable => {
    put(refTable, { id: stepId, lesson_id: id });
    put(refTable.startsWith("course_v2") ? "course_v2_lessons" : "literature_v2_lessons", { ...base, id });
    expect(await assertLessonVoiceAccess("family", "child", { kind: "course", refTable, refId: stepId })).toEqual({ subjectId: "subject", topicId: "topic" });
    await expect(assertLessonVoiceAccess("other-family", "child", { kind: "course", refTable, refId: stepId })).rejects.toThrow("voice_lesson_unavailable");
  });
  it.each(["screen", "reading", "biography", "quiz"])("verifies chapter %s membership with scoped keys", async kind => {
    put("literature_v3_lessons", { ...base, id, package_id: "package", flow: [{ kind, ref_id: "key" }] });
    if (kind === "screen") put("literature_v3_screens", { id: stepId, lesson_id: id, screen_key: "key" });
    if (kind === "biography") put("literature_v3_biographies", { id: stepId, package_id: "package", biography_key: "key" });
    if (kind === "reading") { put("literature_v3_reading_items", { id: stepId, reading_key: "key", work_id: "work" }); put("literature_v3_works", { id: "work", package_id: "package" }); }
    if (kind === "quiz") put("course_v2_questions", { id: stepId, literature_v3_lesson_id: id, question_key: "key" });
    expect(await assertLessonVoiceAccess("family", "child", { ...chapter, stepId: kind === "quiz" ? "key" : stepId })).toEqual({ subjectId: "subject", topicId: "topic" });
  });
  it("rejects a generated session after its current step changes mid-turn", async () => {
    const target = { kind: "lesson" as const, source: "session" as const, sessionId: id, stepId };
    put("lesson_sessions", { ...base, id, child_profile_id: "child", current_step_id: stepId });
    put("library_steps", { id: stepId });
    await expect(assertLessonVoiceAccess("family", "child", target)).resolves.toMatchObject({ sessionId: id });
    put("lesson_sessions", { ...base, id, child_profile_id: "child", current_step_id: "another-step" });
    await expect(assertLessonVoiceAccess("family", "child", target)).rejects.toThrow("voice_lesson_unavailable");
  });
  it("rejects a chapter step removed from its lesson flow mid-turn", async () => {
    put("literature_v3_lessons", { ...base, id, package_id: "package", flow: [{ kind: "screen", ref_id: "key" }] });
    put("literature_v3_screens", { id: stepId, lesson_id: id, screen_key: "key" });
    await expect(assertLessonVoiceAccess("family", "child", chapter)).resolves.toMatchObject({ subjectId: "subject" });
    put("literature_v3_lessons", { ...base, id, package_id: "package", flow: [] });
    await expect(assertLessonVoiceAccess("family", "child", chapter)).rejects.toThrow("voice_lesson_unavailable");
  });
  it("rejects another package's reading even when reading keys collide", async () => {
    put("literature_v3_lessons", { ...base, id, package_id: "package", flow: [{ kind: "reading", ref_id: "key" }] });
    put("literature_v3_reading_items", { id: stepId, reading_key: "key", work_id: "work" });
    put("literature_v3_works", { id: "work", package_id: "another-package" });
    await expect(assertLessonVoiceAccess("family", "child", chapter)).rejects.toThrow("voice_lesson_unavailable");
  });
  it("rejects removed or unrelated chapter steps", async () => {
    put("literature_v3_lessons", { ...base, id, package_id: "package", flow: [{ kind: "screen", ref_id: "key" }] });
    await expect(assertLessonVoiceAccess("family", "child", chapter)).rejects.toThrow("voice_lesson_unavailable");
    put("literature_v3_screens", { id: stepId, lesson_id: id, screen_key: "another-key" });
    await expect(assertLessonVoiceAccess("family", "child", chapter)).rejects.toThrow("voice_lesson_unavailable");
  });
  it("grants friend-chat access with no subject/topic, after verifying chat ownership", async () => {
    put("chats", { id, child_profile_id: "child", kind: "friend", hidden_from_child_at: null });
    f.calls.length = 0;
    await expect(assertLessonVoiceAccess("family", "child", { kind: "friend", chatId: id })).resolves.toEqual({});
    expect(f.calls).toHaveLength(1);
  });
  it("rejects a friend-chat target that is not this child's own (or is hidden)", async () => {
    await expect(assertLessonVoiceAccess("family", "child", { kind: "friend", chatId: id })).rejects.toThrow("voice_lesson_unavailable");
    put("chats", { id, child_profile_id: "another-child", kind: "friend", hidden_from_child_at: null });
    await expect(assertLessonVoiceAccess("family", "child", { kind: "friend", chatId: id })).rejects.toThrow("voice_lesson_unavailable");
    put("chats", { id, child_profile_id: "child", kind: "friend", hidden_from_child_at: "2026-10-23T00:00:00Z" });
    await expect(assertLessonVoiceAccess("family", "child", { kind: "friend", chatId: id })).rejects.toThrow("voice_lesson_unavailable");
  });
  it("rejects archived lessons, stale topics and database failures", async () => {
    const target = { kind: "course" as const, refTable: "course_v2_exercises" as const, refId: stepId };
    put("course_v2_exercises", { id: stepId, lesson_id: id });
    put("course_v2_lessons", { ...base, id, status: "archived" });
    await expect(assertLessonVoiceAccess("family", "child", target)).rejects.toThrow("voice_lesson_unavailable");
    put("course_v2_lessons", { ...base, id }); put("topics", { id: "topic", subject_id: "other" });
    await expect(assertLessonVoiceAccess("family", "child", target)).rejects.toThrow("voice_lesson_unavailable");
    put("topics", { id: "topic", subject_id: "subject" }); f.errors.add("topics");
    await expect(assertLessonVoiceAccess("family", "child", target)).rejects.toThrow("voice_lesson_unavailable");
  });
});
