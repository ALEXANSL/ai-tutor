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
function dates() { return [...container.querySelectorAll("time")].map(node => node.getAttribute("datetime")); }
it.each([false, true])("groups child/parent entries by due day, falls back to lesson day and retains changed completed homework (parent=%s)", parent => {
  render(parent);
  expect(dates()).toEqual(["2026-11-09", "2026-11-10", "2026-11-13"]);
  expect(container.querySelector("h2")?.textContent).toContain("Понеділок, 9 листопада 2026");
  const friday = container.querySelector('time[datetime="2026-11-13"]')!.closest("section")!;
  expect(friday.textContent).toContain("Математика"); expect(friday.textContent).toContain("ДЗ: 1");
  expect(container.textContent).not.toContain("Колір"); expect(container.textContent).toContain("Лексика");
});
it("rebuilds groups after search, all-lessons and completed filters without leaving empty day headings", () => {
  render();
  const search = container.querySelector('input:not([type="checkbox"])')!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Дроби"); search.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(dates()).toEqual(["2026-11-13"]);
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, ""); search.dispatchEvent(new Event("input", { bubbles: true })); });
  const select = container.querySelector("select")!;
  act(() => { select.value = "all"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(dates()).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-13"]);
  expect(container.querySelector('time[datetime="2026-11-11"]')!.closest("section")!.textContent).toContain("ДЗ: 0 · Уроків: 1");
  act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(container.querySelector('time[datetime="2026-11-11"]')!.closest("section")!.textContent).toContain("ДЗ: 1 · Уроків: 1");
});
