import { describe, expect, it } from "vitest";
import { activeSectionTab, SECTION_TABS } from "./SectionTabs";

describe("section tabs (D-131)", () => {
  it("marks the tab of the current page and its sub-pages", () => {
    expect(activeSectionTab("library", "/parent/books")).toBe("/parent/books");
    expect(activeSectionTab("library", "/parent/books/123")).toBe("/parent/books");
    expect(activeSectionTab("library", "/parent/library/books/9")).toBe("/parent/library");
    expect(activeSectionTab("subjects", "/parent/courses/groups")).toBe("/parent/courses");
  });

  it("does not confuse prefixes of other routes", () => {
    expect(activeSectionTab("library", "/parent/booksellers")).toBeNull();
  });

  it("lists every former menu screen in a section", () => {
    const hrefs = Object.values(SECTION_TABS).flat().map((t) => t.href);
    for (const href of ["/parent/courses", "/parent/library", "/parent/videos", "/parent/child", "/parent/conversations", "/parent/budget"]) expect(hrefs).toContain(href);
  });
});
