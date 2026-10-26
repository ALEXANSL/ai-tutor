// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ReadyLessonCatalog } from "./ReadyLessonCatalog";
import type { SubjectTopicOption } from "@/server/subjects/queries";
let root: Root, container: HTMLDivElement;
const base = { pageFrom: null, pageTo: null, literatureLessonId: null, courseLessonId: null, mathCourseV2LessonId: null, literatureV2LessonId: null, literatureV3LessonId: null, hasVideoLesson: false };
const topics: SubjectTopicOption[] = [{ ...base, id: "old", title: "Залишок індексації" }, { ...base, id: "ready", title: "§16. Цивілізації", literatureV3LessonId: "chapter" }, { ...base, id: "math", title: "§2. Дроби", mathCourseV2LessonId: "math-lesson" }];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
it("shows all supported imported formats without old indexed-only topics", () => {
  act(() => root.render(<ReadyLessonCatalog topics={topics} canOpen={true} />));
  expect(container.textContent).not.toContain("Залишок індексації"); expect(container.querySelector('a[href="/literature-v3/chapter"]')).not.toBeNull(); expect(container.querySelector('a[href="/math-course-v2/math-lesson"]')).not.toBeNull();
});
it("lets the parent search by paragraph without creating a lesson", () => {
  act(() => root.render(<ReadyLessonCatalog topics={topics} canOpen={false} />));
  const input = container.querySelector("input")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "16"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  expect(container.querySelectorAll("li")).toHaveLength(1); expect(container.textContent).toContain("Цивілізації"); expect(container.querySelector("a")).toBeNull();
});
