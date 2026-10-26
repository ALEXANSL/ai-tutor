import { expect, it } from "vitest";
import { importedLessonHref } from "./imported-lesson-link";
it.each([
  ["literatureLessonId", "/literature/id"], ["courseLessonId", "/course-lesson/id"], ["mathCourseV2LessonId", "/math-course-v2/id"], ["literatureV2LessonId", "/literature-course-v2/id"], ["literatureV3LessonId", "/literature-v3/id"],
])("opens existing %s in its own reader", (key, href) => { expect(importedLessonHref({ [key]: "id" })).toBe(href); });
it("never offers a generator for a topic without imported content", () => { expect(importedLessonHref({})).toBeNull(); });
