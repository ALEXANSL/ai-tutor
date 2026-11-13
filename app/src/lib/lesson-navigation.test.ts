import { expect, it } from "vitest";
import { nextActiveLessonHref } from "./lesson-navigation";
it("uses the existing lesson order and skips unavailable lessons", () => {
  const lessons = [{ id: "first", status: "active" }, { id: "draft", status: "needs_review" }, { id: "next", status: "active" }];
  expect(nextActiveLessonHref("/literature-v3", "first", lessons)).toBe("/literature-v3/next");
  expect(nextActiveLessonHref("/literature-v3", "next", lessons)).toBeNull();
  expect(nextActiveLessonHref("/literature-v3", "missing", lessons)).toBeNull();
});
it("keeps mixed-format subject navigation when a revised lesson uses the new reader", () => {
  expect(nextActiveLessonHref("/literature-v3", "revision", [{ id: "revision", status: "active" }, { id: "math", status: "active", href: "/math-course-v2/math" }])).toBe("/math-course-v2/math");
});
