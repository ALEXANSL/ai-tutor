// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { schoolPacketFixture } from "@/server/eschool/__fixtures__/packet";
import type { SchoolEntryView, SchoolSource } from "@/lib/eschool";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/eschool", () => ({ setSchoolStatusAction: vi.fn(), schoolLessonOptionsAction: vi.fn(), mapSchoolEntryAction: vi.fn(), launchSchoolHomeworkAction: vi.fn() }));
import { SchoolEntries } from "./SchoolEntries";
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function item(id: string, changes: Partial<SchoolSource>, status: "todo" | "done" = "todo", changed = false): SchoolEntryView {
  return { id, entry: { version: 1, revision: 0, childId: "child", identity: { schoolId: 100, pupilId: 200, classLabel: "" }, source: { ...schoolPacketFixture().entries[1]!, ...changes }, capturedAt: "2026-11-11T12:00:00Z", syncedAt: "2026-11-11T12:00:00Z", status, changed, subjectId: null, topicId: null, lessonHref: null, workHref: null } };
}
const entries = [
  item("friday", { subject: "Математика", topic: "Дроби", lessonDate: "2026-11-09", dueDate: "2026-11-13" }),
  item("lesson", { kind: "lesson", subject: "Географія", topic: "Планета", lessonDate: "2026-11-11", dueDate: null }),
  item("monday", { subject: "Історія", topic: "Цивілізації", lessonDate: "2026-11-09", dueDate: null }),
  item("done", { subject: "Мистецтво", topic: "Колір", lessonDate: "2026-11-11", dueDate: null }, "done"),
  item("changed", { subject: "Українська мова", topic: "Лексика", lessonDate: "2026-11-10", dueDate: null }, "done", true),
];
function render(parent = false) { act(() => root.render(<SchoolEntries entries={entries} parent={parent} initialMode="list" />)); }
function dates() { return [...container.querySelectorAll("section[aria-label] time")].map(node => node.getAttribute("datetime")); }
const click = (label: string) => act(() => [...container.querySelectorAll("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label)!.click());
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-11T09:00:00Z")); });
afterEach(() => vi.useRealTimers());
it.each([false, true])("shows the current week Monday to Friday with weekday + date headings, by due day (parent=%s)", parent => {
  render(parent);
  expect(container.querySelector("h2")?.textContent).toBe("Тиждень: 9 — 15 листопада 2026 р.");
  expect(dates()).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
  const day = (date: string) => container.querySelector(`time[datetime="${date}"]`)!.closest("section")!;
  expect(day("2026-11-09").querySelector("h3")?.textContent).toBe("Понеділок");
  expect(day("2026-11-11").textContent).toContain("Сьогодні");
  expect(day("2026-11-13").textContent).toContain("Математика"); expect(day("2026-11-13").textContent).toContain("ДЗ: 1");
  expect(day("2026-11-12").textContent).toContain("Домашніх завдань немає.");
  // Completed homework is shown like any other: status is not used to hide records.
  expect(container.textContent).toContain("Колір"); expect(container.textContent).toContain("Лексика");
  expect(container.textContent).not.toContain("Показати виконані");
  expect(container.querySelector('select option[value="done"]') !== null).toBe(parent);
});
it("navigates by weeks in week mode and by days in day mode", () => {
  render();
  click("Наступний тиждень");
  expect(container.querySelector("h2")?.textContent).toBe("Тиждень: 16 — 22 листопада 2026 р.");
  expect(container.textContent).not.toContain("Математика");
  expect(container.textContent).toContain("До останнього дня з записами");
  click("Цей тиждень"); click("Попередній тиждень");
  expect(container.querySelector("h2")?.textContent).toContain("2 — 8 листопада");
  click("Цей тиждень"); click("День");
  expect(container.querySelector("h2")?.textContent).toContain("Середа, 11 листопада 2026 р.");
  expect(container.querySelector("h2")?.textContent).toContain("Сьогодні");
  expect(container.textContent).toContain("Колір"); expect(container.textContent).not.toContain("Математика");
  click("Наступний день"); click("Наступний день");
  expect(container.querySelector("h2")?.textContent).toContain("13 листопада 2026");
  expect(container.textContent).toContain("Дроби");
});
it("filters the visible week by search and by lessons + homework", () => {
  render();
  const search = container.querySelector('input[type="search"]')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Дроби"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.textContent).toContain("Дроби"); expect(container.textContent).not.toContain("Цивілізації");
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, ""); search.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.textContent).not.toContain("Планета");
  const select = container.querySelector('select[aria-label="Показати записи"]') as HTMLSelectElement;
  act(() => { select.value = "all"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.textContent).toContain("Планета");
});
it("offers the history subject link for an old unmapped diary entry and keeps it beside a direct lesson", () => {
  const history = item("history", { subject: "Історія України. Всесвітня історія" });
  act(() => root.render(<SchoolEntries entries={[history]} subjects={[{ id: "history-subject", name: "Історія" }]} initialMode="list" />));
  expect(container.querySelector('a[href="/subject/history-subject?school=history"]')?.textContent).toBe("Відкрити предмет");
  act(() => root.render(<SchoolEntries entries={[{ ...history, entry: { ...history.entry, subjectId: "history-subject", lessonHref: "/literature-v3/lesson" } }]} subjects={[{ id: "history-subject", name: "Історія" }]} initialMode="list" />));
  expect(container.querySelector('a[href="/literature-v3/lesson"]')).toBeTruthy();
  expect(container.querySelector('a[href="/subject/history-subject?school=history"]')).toBeTruthy();
});
