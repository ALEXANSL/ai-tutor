import { beforeEach, expect, it, vi } from "vitest";
import { studioProjectFixture, studioLessonFixture, studioVisualFixture } from "@/server/studio/__fixtures__/project";
const f = vi.hoisted(() => ({ detail: vi.fn(), parent: vi.fn(), child: vi.fn(), start: vi.fn(), resume: vi.fn(), pause: vi.fn(), read: vi.fn(), save: vi.fn(), kick: vi.fn(), links: vi.fn(), text: vi.fn(), cleanup: vi.fn(), step: vi.fn(), scope: vi.fn(), update: vi.fn(), activate: vi.fn(), schedule: vi.fn(), validate: vi.fn() }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: (family: string) => { f.scope(family); const q = { eq: () => q, order: () => q, limit: () => q, maybeSingle: f.step }; return { select: () => q, update: (table: string, values: unknown) => { f.update(table, values); return q; } }; } }));
vi.mock("@/server/subjects/queries", () => ({ getSubjectDetail: f.detail }));
vi.mock("@/server/auth/guards", () => ({ requireParentAccess: f.parent, requireChild: f.child }));
vi.mock("@/server/studio/workflow", () => ({ startStudio: f.start, resumeStudio: f.resume, pauseStudio: f.pause, scheduleStudio: f.schedule, validateStudioLesson: f.validate }));
vi.mock("@/server/studio/store", () => ({ readStudioProject: f.read, saveStudioProject: f.save, STUDIO_STEP: "studio.step" }));
vi.mock("@/server/studio/publish", () => ({ activateStudioPublication: f.activate }));
vi.mock("@/server/studio/wake", () => ({ kickStudio: f.kick }));
vi.mock("@/server/studio/links", () => ({ studioLinksForPath: f.links }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));
vi.mock("unpdf", () => ({ getDocumentProxy: async () => ({ numPages: 10, cleanup: f.cleanup }), extractText: f.text }));
import { createStudioAction, commandStudioAction, pollStudioAction, withdrawStudioAction, pauseStudioAction, extractStudioFileAction, studioLessonLinksAction, setStudioAccessAction, saveStudioLessonAction, reviseImportedLessonAction } from "./studio";
const id = "11111111-1111-4111-8111-111111111111";
beforeEach(() => { vi.clearAllMocks(); f.parent.mockResolvedValue({ familyId: "own-family" }); f.child.mockResolvedValue({ ctx: { familyId: "child-family" } }); f.start.mockResolvedValue(id); f.read.mockResolvedValue(studioProjectFixture({ state: "plan_ready" })); });
it("rejects a child/unauthorized caller before reading drafts, running models, extracting files or publishing", async () => {
  f.parent.mockRejectedValue(new Error("parent only"));
  await expect(createStudioAction({})).rejects.toThrow(); await expect(commandStudioAction({})).rejects.toThrow(); await expect(pollStudioAction(id)).rejects.toThrow(); await expect(withdrawStudioAction(id, 0)).rejects.toThrow(); await expect(extractStudioFileAction(new FormData())).rejects.toThrow(); await expect(pauseStudioAction(id, 0)).rejects.toThrow();
  expect(f.start).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled(); expect(f.text).not.toHaveBeenCalled();
});
it("uses the authorized family and a stable request ID, rejects forged selectors before paid work", async () => {
  expect(await createStudioAction({ requestId: id, request: studioProjectFixture().request })).toEqual({ status: "ok", id });
  expect(f.start).toHaveBeenCalledWith("own-family", studioProjectFixture().request, id);
  expect((await createStudioAction({ requestId: "invalid", request: studioProjectFixture().request })).status).toBe("error"); expect(f.start).toHaveBeenCalledTimes(1);
  expect((await commandStudioAction({ id, revision: -1, command: "publish" })).status).toBe("error"); expect(f.resume).not.toHaveBeenCalled();
});
it("provides only whitelisted public lesson navigation to the authenticated child family", async () => {
  f.links.mockResolvedValue({ back: "/literature-v3/base", links: [] });
  expect(await studioLessonLinksAction("/literature-v3/lesson")).toEqual({ back: "/literature-v3/base", links: [] }); expect(f.links).toHaveBeenCalledWith("child-family", "/literature-v3/lesson"); expect(f.read).not.toHaveBeenCalled();
});
it("does not turn empty PDF-page labels into source material for an image-only scan", async () => {
  f.text.mockResolvedValue({ text: Array(10).fill("   "), totalPages: 10 }); const form = new FormData(); form.set("file", new File(["pdf-fixture"], "scan.pdf", { type: "application/pdf" }));
  const result = await extractStudioFileAction(form); expect(result.status).toBe("error"); if (result.status === "error") expect(result.message).toContain("текстового шару"); expect(f.cleanup).toHaveBeenCalled();
});

it("reports queued versus running work from the parent family without starting a second paid task", async () => {
  f.read.mockResolvedValue(studioProjectFixture({ state: "generating", phase: "author" }));
  f.step.mockResolvedValue({ data: { status: "queued", run_after: "2026-11-11T14:00:00Z" }, error: null });
  const queued = await pollStudioAction(id); expect(queued).toMatchObject({ status: "ok", activity: { queue: "queued", runAfter: "2026-11-11T14:00:00Z" } }); expect(f.kick).toHaveBeenCalledWith("own-family", id); expect(f.scope).toHaveBeenCalledWith("own-family");
  f.kick.mockClear(); f.step.mockResolvedValue({ data: { status: "running", locked_until: "2099-01-01T00:00:00Z" }, error: null });
  expect(await pollStudioAction(id)).toMatchObject({ status: "ok", activity: { queue: "running" } }); expect(f.kick).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
});
it("reports an unavailable status lookup without claiming a provider is working", async () => {
  f.read.mockResolvedValue(studioProjectFixture({ state: "generating" })); f.step.mockResolvedValue({ data: null, error: { message: "private database error" } });
  const result = await pollStudioAction(id); expect(result).toMatchObject({ activity: { queue: "unavailable" } }); expect(JSON.stringify(result)).not.toContain("private database error");
});

it("restores a withdrawn publication without authoring or another paid model call", async () => {
  const project = studioProjectFixture({ state: "withdrawn", publication: { subjectId: "subject", packageId: "package", lessons: [] } }); f.read.mockResolvedValue(project);
  expect((await setStudioAccessAction({ id, revision: 0, enabled: true })).status).toBe("ok");
  expect(f.activate).toHaveBeenCalledWith("own-family", project.publication, true);
  expect(f.save).toHaveBeenCalledWith("own-family", id, project, expect.objectContaining({ state: "published", childAccess: "enabled" }));
  expect(f.resume).not.toHaveBeenCalled(); expect(f.schedule).not.toHaveBeenCalled();
});
it("saves a manual correction on a hidden lesson and schedules only the reviewer", async () => {
  const project = studioProjectFixture({ state: "withdrawn", publication: { subjectId: "subject", packageId: "package", lessons: [] }, units: [{ content: studioLessonFixture, visuals: [studioVisualFixture], review: { verdict: "pass", issues: [], summary: "Пройдено" } }] });
  f.read.mockResolvedValue(project); f.validate.mockImplementation((_project, lesson) => lesson); f.save.mockResolvedValue({ ...project, revision: 1 });
  const edited = { ...studioLessonFixture, title: "Уточнений урок" };
  expect((await saveStudioLessonAction({ id, revision: 0, lessonIndex: 0, lesson: edited, budgetUsd: 3 })).status).toBe("ok");
  const changes = f.save.mock.calls[0]![3]; expect(changes).toMatchObject({ state: "generating", phase: "review", childAccess: "disabled", publicationRevision: true });
  expect(changes.units[0].content.title).toBe("Уточнений урок"); expect(changes.units[0].review).toBeNull(); expect(f.schedule).toHaveBeenCalledOnce(); expect(f.resume).not.toHaveBeenCalled();
});
it("does not change publication access while a worker is active or from a stale page", async () => {
  f.read.mockResolvedValue(studioProjectFixture({ state: "generating", publication: { subjectId: "subject", packageId: "package", lessons: [] } }));
  expect((await setStudioAccessAction({ id, revision: 0, enabled: true })).status).toBe("error"); expect(f.activate).not.toHaveBeenCalled();
});
it("can disable and restore the same old publication repeatedly without recreating its lessons", async () => {
  let project = studioProjectFixture({ state: "published", publication: { subjectId: "own-course", packageId: "same-package", lessons: [{ id: "same-lesson", topicId: "same-topic", title: "Урок" }] } });
  f.read.mockImplementation(async () => project);
  f.save.mockImplementation(async (_family, _id, previous, changes) => { project = { ...previous, ...changes, revision: previous.revision + 1 }; return project; });
  expect((await setStudioAccessAction({ id, revision: 0, enabled: false })).status).toBe("ok");
  expect(project).toMatchObject({ state: "withdrawn", childAccess: "disabled", revision: 1 });
  expect(f.update).toHaveBeenCalledWith("subjects", { active: false });
  expect((await setStudioAccessAction({ id, revision: 1, enabled: true })).status).toBe("ok");
  expect(project).toMatchObject({ state: "published", childAccess: "enabled", revision: 2 });
  expect(project.publication!.lessons[0]!.id).toBe("same-lesson");
  expect((await setStudioAccessAction({ id, revision: 2, enabled: false })).status).toBe("ok");
  expect(project.childAccess).toBe("disabled"); expect(f.resume).not.toHaveBeenCalled(); expect(f.schedule).not.toHaveBeenCalled();
});
it("restores the existing publication during a ready revision without publishing the edited candidate", async () => {
  const project = studioProjectFixture({ state: "ready", publicationRevision: true, childAccess: "disabled", publication: { subjectId: "subject", packageId: "old-package", lessons: [] } });
  f.read.mockResolvedValue(project);
  expect((await setStudioAccessAction({ id, revision: 0, enabled: true })).status).toBe("ok");
  expect(f.activate).toHaveBeenCalledWith("own-family", project.publication, true);
  expect(f.save.mock.calls[0]![3]).toEqual({ childAccess: "enabled" });
  expect(f.schedule).not.toHaveBeenCalled();
});
it("rejects stale controls and child callers before touching lesson visibility or saving edits", async () => {
  f.read.mockResolvedValue(studioProjectFixture({ revision: 3, state: "withdrawn", publication: { subjectId: "subject", packageId: "package", lessons: [] } }));
  expect((await setStudioAccessAction({ id, revision: 0, enabled: true })).status).toBe("error"); expect(f.activate).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  f.parent.mockRejectedValue(Error("parent only")); f.read.mockClear();
  await expect(setStudioAccessAction({ id, revision: 3, enabled: true })).rejects.toThrow();
  await expect(saveStudioLessonAction({})).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
});

it("creates one owned revision draft and does not let a repeated operation start paid work twice", async () => {
  const subjectId = "22222222-2222-4222-8222-222222222222", topicId = "33333333-3333-4333-8333-333333333333";
  const input = { subjectId, topicId, requestId: id, instructions: "Додай навчальний матеріал замість самих запитань", budgetUsd: 3, age: 12, grade: 6 };
  f.detail.mockResolvedValue({ id: subjectId, name: "Зарубіжна література", topics: [{ id: topicId, title: "Міфи", literatureV3LessonId: "base" }] }); f.read.mockResolvedValue(null);
  const first = await reviseImportedLessonAction(input); expect(first.status).toBe("ok"); expect(f.start).toHaveBeenCalledWith("own-family", expect.objectContaining({ mode: "revision", subjectId, topicId, lessonCount: 1 }), expect.any(String), id);
  const canonicalId = f.start.mock.calls[0]![2]; f.start.mockClear();
  const existing = studioProjectFixture({ state: "published", revisionRequestId: id, request: { ...studioProjectFixture().request, mode: "revision", subjectId, topicId } }); f.read.mockResolvedValue(existing);
  expect(await reviseImportedLessonAction(input)).toMatchObject({ status: "ok", id: canonicalId }); expect(f.start).not.toHaveBeenCalled(); expect(f.resume).not.toHaveBeenCalled();
  const nextId = "44444444-4444-4444-8444-444444444444"; await reviseImportedLessonAction({ ...input, requestId: nextId });
  expect(f.resume).toHaveBeenCalledWith("own-family", canonicalId, existing.revision, "revise", undefined, input.instructions, 3, 0, nextId, { age: 12, grade: 6 });
});
it("rejects a foreign selected lesson before model work", async () => {
  f.detail.mockResolvedValue(null);
  expect((await reviseImportedLessonAction({ subjectId: id, topicId: id, requestId: id, instructions: "Перероби матеріал уроку", budgetUsd: 3, age: 12, grade: 6 })).status).toBe("error"); expect(f.start).not.toHaveBeenCalled();
});
