// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LastLessonHighlight } from "./LastLessonHighlight";
let root: Root, container: HTMLDivElement;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); container = document.createElement("div"); document.body.append(container); root = createRoot(container); HTMLElement.prototype.scrollIntoView = vi.fn(); vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; }); vi.stubGlobal("cancelAnimationFrame", vi.fn()); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("scrolls to the requested card and highlights it instead of the last visited lesson", async () => {
  localStorage.setItem("lastLesson:subject", JSON.stringify({ topicId: "previous" }));
  await act(async () => root.render(<><LastLessonHighlight subjectId="subject" topicId="previous" schoolContext><p>Previous</p></LastLessonHighlight><LastLessonHighlight subjectId="subject" topicId="selected" schoolContext focusRequest="record"><p>Selected</p></LastLessonHighlight></>));
  expect(container.querySelectorAll(".ring-2")).toHaveLength(1); expect(container.querySelector('[aria-current="location"]')?.id).toBe("topic-selected");
  expect(container.textContent).toContain("Тема зі щоденника"); expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
});
it("retains ordinary last-lesson highlighting outside a diary navigation", async () => {
  localStorage.setItem("lastLesson:subject", JSON.stringify({ topicId: "previous" }));
  await act(async () => root.render(<LastLessonHighlight subjectId="subject" topicId="previous"><p>Previous</p></LastLessonHighlight>));
  expect(container.querySelector(".ring-2")).not.toBeNull(); expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
});
