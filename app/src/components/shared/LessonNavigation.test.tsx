// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a> }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => <span>Тема оформлення</span> }));
vi.mock("@/components/child/VideoLessonButton", () => ({ VideoLessonButton: () => <button>Відео</button> }));
import { LessonNavBar } from "./LessonNavBar";
import { StepNavBar } from "./StepNavBar";
let root: Root, container: HTMLDivElement;
function Controls() { const [on, setOn] = useState(false); return <button aria-pressed={on} onClick={() => setOn(value => !value)}>Озвучення</button>; }
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  act(() => root.render(<LessonNavBar subjectId="subject" videoLessonTopicId="topic" extraControls={<Controls />} courseNav={{ basePath: "/lesson", currentLessonId: "one", topicId: "topic", lessons: [{ id: "one", orderNo: 1, title: "Урок", status: "active" }, { id: "two", orderNo: 2, title: "Наступний", status: "active" }] }} />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
const menu = () => container.querySelector<HTMLButtonElement>('button[aria-label="Меню уроку"]')!;
it("exposes a collapsed menu and preserves audio settings across closing", () => {
  expect(menu().getAttribute("aria-expanded")).toBe("false");
  act(() => menu().click());
  const control = [...container.querySelectorAll("button")].find(button => button.textContent === "Озвучення")!;
  act(() => control.click()); act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(menu().getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(menu());
  act(() => menu().click()); expect(control.getAttribute("aria-pressed")).toBe("true");
});
it("keeps alarm and subject navigation immediate", () => {
  act(() => container.querySelector<HTMLButtonElement>('[data-lesson-alarm]')!.click()); expect(push).toHaveBeenCalledWith("/today");
});
it("does not steal Escape from a foreground dialog", () => {
  act(() => menu().click()); const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); document.body.append(dialog);
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(menu().getAttribute("aria-expanded")).toBe("true"); dialog.remove();
});
it("retains next/back actions and the original book control", () => {
  const back = vi.fn(), next = vi.fn(), book = vi.fn();
  act(() => root.render(<StepNavBar label="Крок" onBack={back} onNext={next} backDisabled={true} nextDisabled={false} middleControl={<button onClick={book}>Підручник</button>} />));
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Назад"]')!.click()); expect(back).not.toHaveBeenCalled();
  act(() => container.querySelector<HTMLButtonElement>('[data-book-control] button')!.click()); expect(book).toHaveBeenCalledOnce();
  act(() => [...container.querySelectorAll("button")].at(-1)!.click()); expect(next).toHaveBeenCalledOnce();
});
