// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { studioProjectFixture, studioPlanFixture, studioLessonFixture, studioVisualFixture } from "@/server/studio/__fixtures__/project";
import type { StudioProject as Project, StudioActivity } from "@/lib/studio";
const f = vi.hoisted(() => ({ command: vi.fn(), poll: vi.fn(), pause: vi.fn() }));
vi.mock("@/app/actions/studio", () => ({ commandStudioAction: f.command, pollStudioAction: f.poll, pauseStudioAction: f.pause, withdrawStudioAction: vi.fn() }));
vi.mock("./StudioPreview", () => ({ StudioPreview: () => <p>Попередній матеріал уроку</p> }));
import { StudioProject } from "./StudioProject";
const id = "11111111-1111-4111-8111-111111111111";
const unit = { content: studioLessonFixture, visuals: [studioVisualFixture], review: { verdict: "revise" as const, issues: ["Уточни приклад"], summary: "Потрібні виправлення" } };
function project(changes: Partial<Project> = {}) { return studioProjectFixture({ state: "needs_changes", phase: "review", plan: studioPlanFixture, units: [unit], ...changes }); }
function observed(p: Project, queue: StudioActivity["queue"] = "running") { return { status: "ok", project: p, activity: { queue, checkedAt: "2026-11-11T14:00:00Z" } }; }
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(() => {}); HTMLElement.prototype.scrollIntoView = vi.fn(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); f.command.mockResolvedValue({ status: "ok" }); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function render(p = project()) { act(() => root.render(<StudioProject id={id} initial={p} />)); }
function button(text: string) { const b = [...container.querySelectorAll("button")].find(node => node.textContent === text); if (!b) throw new Error(`Missing ${text}`); return b; }
async function click(text: string) { await act(async () => { button(text).click(); }); }
it("acknowledges a revision immediately, disables repeat clicks and shows the running author without copying review", async () => {
  let accept!: (value: unknown) => void; f.command.mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }));
  f.poll.mockResolvedValue(observed(project({ state: "generating", phase: "author", revision: 1, activeCall: true })));
  render(); expect(container.textContent).toContain("копіювати рецензію не потрібно"); expect(container.textContent).not.toContain("Опублікувати для дитини");
  await click("Виправити зауваження рецензента"); expect(container.textContent).toContain("Запускаємо доопрацювання уроку…"); expect(container.querySelector(".animate-spin")).not.toBeNull(); expect(button("Виправити зауваження рецензента").disabled).toBe(true); expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  await act(async () => { accept({ status: "ok" }); });
  expect(f.command).toHaveBeenCalledTimes(1); expect(f.command.mock.calls[0]![0]).toMatchObject({ command: "revise", feedback: "", lessonIndex: 0 });
  expect(container.textContent).toContain("Доопрацювання запущено"); expect(container.textContent).toContain("ШІ обробляє запит"); expect(container.textContent).toContain("попередня версія, готуємо оновлення");
});
it("distinguishes queued work and advances the stage on refresh without fabricated percentages", async () => {
  f.poll.mockResolvedValueOnce(observed(project({ state: "generating", phase: "author", revision: 1 }), "queued"));
  render(project({ state: "generating", phase: "author", revision: 1 })); await act(async () => {});
  expect(container.textContent).toContain("Завдання в черзі"); expect(container.textContent).not.toContain("ШІ обробляє запит");
  f.poll.mockResolvedValueOnce(observed(project({ state: "generating", phase: "design", revision: 2, activeCall: true })));
  await click("Оновити стан"); expect(container.querySelector('[aria-current="step"]')!.textContent).toContain("Схеми"); expect(container.textContent).toContain("Стан перевірено"); expect(container.querySelector('[role="progressbar"]')).toBeNull();
});
it("makes publication visible above the lesson and links a new published course to Courses", async () => {
  const p = project({ state: "ready", units: [{ ...unit, review: { verdict: "pass", issues: [], summary: "Готово" } }] });
  f.poll.mockResolvedValue(observed({ ...p, state: "published", revision: 1, publication: { subjectId: id, packageId: id, lessons: [{ id, topicId: id, title: "Урок" }] } }, "none"));
  render(p); expect(container.textContent).toContain("блоці «Курси»"); await click("Опублікувати для дитини");
  expect(container.textContent).toContain("Матеріал опубліковано"); expect(container.querySelector(`a[href="/parent/courses/${id}"]`)).not.toBeNull();
});
it("shows loss of status connection instead of pretending the current state is confirmed", async () => {
  f.poll.mockRejectedValueOnce(new Error("offline")); render(project({ state: "generating", phase: "review", revision: 4, activeCall: true })); await act(async () => {});
  expect(container.textContent).toContain("Зв’язок зі сторінкою перервано");
  f.poll.mockResolvedValue(observed(project({ state: "needs_changes", revision: 5 }))); await click("Оновити стан"); expect(button("Виправити зауваження рецензента")).not.toBeNull(); expect(container.textContent).not.toContain("Зв’язок зі сторінкою перервано");
});
it("keeps a newer result when a previous poll finishes late", async () => {
  let stale!: (value: unknown) => void; f.poll.mockImplementationOnce(() => new Promise(resolve => { stale = resolve; })); render(project({ state: "generating", phase: "author", revision: 2 }));
  f.poll.mockResolvedValueOnce(observed(project({ state: "ready", revision: 5 }))); await click("Оновити стан");
  await act(async () => { stale(observed(project({ state: "generating", phase: "design", revision: 3 }))); });
  expect(button("Опублікувати для дитини")).not.toBeNull(); expect(container.querySelector(".animate-spin")).toBeNull();
});

it("allows a parent to describe corrections after publication and clearly keeps the child version until republish", async () => {
  const published = project({ state: "published", units: [{ ...unit, review: { verdict: "pass", issues: [], summary: "Пройдено" } }], publication: { subjectId: "subject", packageId: "package", lessons: [] } });
  f.poll.mockResolvedValue(observed({ ...published, state: "generating", phase: "author", publicationRevision: true, revision: 1 }));
  render(published);
  expect(container.querySelector('a[href="#studio-revision"]')?.textContent).toBe("Виправити опублікований урок");
  expect(container.querySelector("#studio-revision")).not.toBeNull();
  expect(button("Допрацювати урок 1").disabled).toBe(true);
  const field = container.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Зроби таблицю зрозумілою"); field.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(button("Допрацювати урок 1").disabled).toBe(false);
  await click("Допрацювати урок 1");
  expect(f.command.mock.calls[0]![0]).toMatchObject({ command: "revise", feedback: "Зроби таблицю зрозумілою" });
  expect(container.textContent).toContain("дитина бачить чинну версію");
});
