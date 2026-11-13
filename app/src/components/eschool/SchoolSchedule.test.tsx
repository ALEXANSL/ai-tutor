// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { schoolPacketFixture } from "@/server/eschool/__fixtures__/packet";
import type { SchoolEntryView } from "@/lib/eschool";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/eschool", () => ({ setSchoolStatusAction: vi.fn(), schoolLessonOptionsAction: vi.fn(), mapSchoolEntryAction: vi.fn(), launchSchoolHomeworkAction: vi.fn() }));
import { SchoolEntries } from "./SchoolEntries";
let root: Root, container: HTMLDivElement;
const packet = schoolPacketFixture();
const records = packet.entries.map((source, i) => ({ id: String(i), entry: { version: 1, revision: 0, childId: "child", identity: packet.identity, source: { ...source, schedule: { number: 4, start: "10:55", room: "227" } }, capturedAt: packet.capturedAt, syncedAt: packet.capturedAt, status: "todo", changed: false, subjectId: null, topicId: null, lessonHref: null, workHref: null } })) as SchoolEntryView[];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-13T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function click(name: string) { const button = [...container.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === name || node.textContent === name)!; expect(button).toBeTruthy(); act(() => button.click()); }
it.each([false, true])("defaults to a weekly timetable, merges lesson/homework, and keeps details accessible (parent=%s)", parent => {
  act(() => root.render(<SchoolEntries entries={records} parent={parent} />));
  const table = container.querySelector('[role="table"]')!;
  expect(table.querySelectorAll('[role="columnheader"]')).toHaveLength(7);
  expect(table.querySelectorAll('[role="cell"] button')).toHaveLength(1);
  expect(table.textContent).toContain("10:55"); expect(table.textContent).toContain("к. 227"); expect(table.textContent).toContain("ДЗ");
  act(() => table.querySelector<HTMLButtonElement>('button')!.click());
  expect(container.querySelector('dialog[open]')?.querySelectorAll('article')).toHaveLength(2);
  expect(container.querySelector('dialog')?.textContent).toContain(records[1]!.entry.source.text);
  click("Закрити урок щоденника"); expect(container.querySelector('dialog')).toBeNull();
  click("Наступний тиждень"); expect(table.textContent).not.toContain("10:55");
  click("Сьогодні"); expect(table.textContent).toContain("10:55");
  click("Список ДЗ"); expect(container.querySelector('[role="table"]')).toBeNull(); expect(container.querySelector('article')).toBeTruthy();
});
it("retains unscheduled old packets and adds Sunday only when needed", () => {
  const old = records.map(item => ({ ...item, entry: { ...item.entry, source: { ...item.entry.source, lessonDate: "2026-11-15", schedule: undefined } } }));
  act(() => root.render(<SchoolEntries entries={old} />));
  const table = container.querySelector('[role="table"]')!;
  expect(table.querySelectorAll('[role="columnheader"]')).toHaveLength(8);
  expect(table.textContent).toContain("неділя"); expect(table.textContent).not.toContain("10:55");
  expect(container.textContent).toContain("немає часу уроків");
});
