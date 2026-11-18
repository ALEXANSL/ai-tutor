// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudioDraftValues } from "@/server/studio/drafts";

const f = vi.hoisted(() => ({ save: vi.fn(), launch: vi.fn(), push: vi.fn(), replace: vi.fn(), topics: vi.fn(), ready: true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: f.push, replace: f.replace }) }));
vi.mock("@/app/actions/studio-drafts", () => ({ saveStudioFormDraftAction: f.save, launchStudioFormDraftAction: f.launch }));
vi.mock("@/app/actions/video-lessons", () => ({ listSubjectTopicsForVideoAction: f.topics }));
vi.mock("@/lib/busy-signal", () => ({ withBusySignal: (work: () => unknown) => work() }));
vi.mock("./StudioSourceUpload", () => ({ StudioSourceUpload: ({ onReady, onSelect, selectedId }: {
  onReady?: (value: boolean) => void; onSelect?: (book: { id: string; title: string }) => void; selectedId: string;
}) => {
  useEffect(() => { onReady?.(f.ready); }, [onReady, selectedId]);
  return <button type="button" onClick={() => onSelect?.({ id: "33333333-3333-4333-8333-333333333333", title: "Завантажений посібник" })}>Test uploaded material</button>;
} }));
import { StudioCreate } from "./StudioCreate";

const subjectA = "11111111-1111-4111-8111-111111111111";
const subjectB = "22222222-2222-4222-8222-222222222222";
const material = "33333333-3333-4333-8333-333333333333";
const topic = "44444444-4444-4444-8444-444444444444";
const id = "55555555-5555-4555-8555-555555555555";
const projectId = "66666666-6666-4666-8666-666666666666";
const storageKey = "studio-form:opaque-family-a";
const subjects = [{ id: subjectA, code: "math", name: "Математика" }, { id: subjectB, code: "english", name: "Англійська мова" }];
const values: StudioDraftValues = {
  mode: "course", title: "Мій урок", idea: "Навчитися розуміти дроби", targetLanguage: null,
  sourceText: "Текст джерела", subjectId: null, topicId: null, materialId: null,
  pageFrom: null, pageTo: null, age: 12, grade: 7, lessonCount: 4, minutes: 35, budgetUsd: 5,
};
let root: Root | null;
let container: HTMLDivElement;
beforeEach(() => {
  Object.values(f).forEach((value) => { if (typeof value === "function" && "mockReset" in value) value.mockReset(); });
  f.ready = true;
  f.topics.mockResolvedValue([{ id: topic, title: "Збережена тема" }]);
  f.save.mockImplementation(async (input: { id: string; revision: number | null }) => ({ status: "ok", id: input.id, revision: (input.revision ?? 0) + 1 }));
  f.launch.mockResolvedValue({ status: "ok", id: projectId });
  localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount()); root = null;
  container.remove(); localStorage.clear(); vi.restoreAllMocks();
});
async function render(props: Partial<React.ComponentProps<typeof StudioCreate>> = {}) {
  await act(async () => root!.render(<StudioCreate subjects={subjects} books={[]} storageKey={storageKey} {...props} />));
}
function field(label: string) { return container.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!; }
function change(label: string, text: string) {
  const input = field(label);
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!button) throw new Error(`No button ${text}`);
  await act(async () => { button.click(); });
}
function stored() { return [...Array(localStorage.length)].map((_, index) => localStorage.key(index)!).map(key => ({ key, data: JSON.parse(localStorage.getItem(key)!) })); }

describe("StudioCreate durable form drafts", () => {
  it("saves an incomplete form without HTML required validation, ready source, or generation", async () => {
    f.ready = false;
    await render({ initialMaterial: material, books: [{ id: material, title: "Книга" }] });
    change("Назва", "Ще дописую");
    change("Сторінка від", "9");
    await click("Зберегти чернетку");
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.save.mock.calls[0]![0]).toEqual(expect.objectContaining({ revision: null, values: expect.objectContaining({ title: "Ще дописую", idea: "", materialId: material, pageFrom: 9, pageTo: null }) }));
    expect(f.launch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Чернетку збережено, генерацію не запущено");
    expect(field("Що дитина має зрозуміти або навчитися робити?").value).toBe("");
  });

  it("restores all saved fields and saves the latest edit before explicit launch", async () => {
    await render({ initialDraft: { id, revision: 3, values: { ...values, targetLanguage: "de", materialId: material, pageFrom: 4, pageTo: 8 }, projectId: null }, books: [{ id: material, title: "Підручник" }] });
    expect(field("Мова, яку вивчаємо").value).toBe("de");
    expect(field("Кількість уроків").value).toBe("4");
    expect(field("Хвилин на урок").value).toBe("35");
    expect(field("Ліміт підготовки").value).toBe("5");
    expect(field("Книга з бібліотеки").value).toBe(material);
    expect(field("Сторінка від").value).toBe("4");
    change("Назва", "Остання назва перед запуском");
    await click("Запустити підготовку");
    const saved = f.save.mock.calls[0]![0];
    expect(saved).toEqual(expect.objectContaining({ id, revision: 3, values: expect.objectContaining({ title: "Остання назва перед запуском", grade: 7, lessonCount: 4, targetLanguage: "de" }) }));
    expect(f.launch).toHaveBeenCalledWith({ id, revision: 4 });
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.launch.mock.invocationCallOrder[0]!);
    expect(f.push).toHaveBeenCalledWith(`/parent/studio/${projectId}`);
    expect(stored()).toHaveLength(0);
  });

  it("retains the durable draft and form when launch fails", async () => {
    f.launch.mockResolvedValueOnce({ status: "error", message: "Джерело ще обробляється" });
    await render({ initialDraft: { id, revision: 3, values, projectId: null } });
    change("Назва", "Залишити цей текст");
    await click("Запустити підготовку");
    expect(f.save).toHaveBeenCalledOnce();
    expect(field("Назва").value).toBe("Залишити цей текст");
    expect(container.textContent).toContain("заповнення не втрачено");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Джерело ще обробляється");
    expect(f.replace).toHaveBeenCalledWith(`/parent/studio/new?draft=${id}`, { scroll: false });
    expect(f.push).not.toHaveBeenCalled();
    expect(stored().some(item => item.data.id === id && item.data.values.title === "Залишити цей текст")).toBe(true);
  });

  it("recovers the latest partial form and uploaded material reference after switching to child mode", async () => {
    f.ready = false;
    await render();
    change("Назва", "Не загубити під час перемикання");
    change("Що дитина має зрозуміти або навчитися робити?", "Ще пишу мету");
    await click("Test uploaded material");
    change("Сторінка від", "14");
    change("Власні матеріали", "Мої нотатки");
    act(() => { window.dispatchEvent(new Event("pagehide")); root!.render(<p>Дитячий режим</p>); });
    const originalId = stored()[0]!.data.id;
    await render();
    expect(field("Назва").value).toBe("Не загубити під час перемикання");
    expect(field("Що дитина має зрозуміти або навчитися робити?").value).toBe("Ще пишу мету");
    expect(field("Власні матеріали").value).toBe("Мої нотатки");
    expect(field("Сторінка від").value).toBe("14");
    expect(field("Сторінка до").value).toBe("");
    expect(field("Книга з бібліотеки").value).toBe(material);
    expect(container.querySelector(`option[value="${material}"]`)!.textContent).toBe("Завантажений посібник");
    await click("Зберегти чернетку");
    expect(f.save.mock.calls[0]![0].id).toBe(originalId);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it("isolates device recovery across families", async () => {
    await render();
    change("Назва", "Лише для сім’ї A");
    await render({ storageKey: "studio-form:opaque-family-b" });
    expect(field("Назва").value).toBe("");
    await render();
    expect(field("Назва").value).toBe("Лише для сім’ї A");
    expect(f.save).not.toHaveBeenCalled();
  });

  it("does not overwrite an explicit new subject choice with a different recovery context", async () => {
    const key = `${storageKey}:new:${JSON.stringify([subjectA, "", ""])}`;
    localStorage.setItem(key, JSON.stringify({ version: 1, id, revision: null, values: { ...values, subjectId: subjectB }, materialTitle: "", base: "{}", updatedAt: new Date().toISOString() }));
    await render({ initialSubject: subjectA });
    expect(field("Предмет або курс").value).toBe(subjectA);
    expect(field("Назва").value).toBe("");
    expect(container.textContent).toContain("Поточні поля не замінено");
    await click("Відновити як окрему чернетку");
    expect(field("Предмет або курс").value).toBe(subjectB);
    expect(field("Назва").value).toBe(values.title);
    await click("Зберегти чернетку");
    expect(f.save.mock.calls[0]![0].id).not.toBe(id);
    expect(f.save.mock.calls[0]![0].revision).toBeNull();
  });

  it("keeps local recovery and gives a Ukrainian message if saving loses network access", async () => {
    f.save.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await render();
    change("Назва", "Не загубити через мережу");
    await click("Зберегти чернетку");
    expect(field("Назва").value).toBe("Не загубити через мережу");
    expect(stored()[0]!.data.values.title).toBe("Не загубити через мережу");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("перевір з’єднання");
    expect(container.textContent).not.toContain("Failed to fetch");
  });

  it("preserves fields and device recovery after a save revision conflict", async () => {
    f.save.mockResolvedValueOnce({ status: "error", message: "Чернетку змінено в іншій вкладці" });
    await render({ initialDraft: { id, revision: 3, values, projectId: null } });
    change("Назва", "Моя незбережена зміна");
    await click("Зберегти чернетку");
    expect(field("Назва").value).toBe("Моя незбережена зміна");
    expect(stored()[0]!.data.values.title).toBe("Моя незбережена зміна");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("іншій вкладці");
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.launch).not.toHaveBeenCalled();
  });
});
