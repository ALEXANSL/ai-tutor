import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Nav review (2026-09-27), finding #1: the only primary button on the
// post-lesson summary screen ("Ще урок") pointed at the parent-only
// `/parent/subjects/:id` route (guarded by `requireParentAccess`), a
// dead-end for a plain child account. It must point at the child-facing
// `/subject/:id` route instead (added in S4).
import { LessonSummaryScreen } from "./LessonSummaryScreen";

describe("LessonSummaryScreen", () => {
  it('"Ще урок" links to the child route, not the parent-only one', () => {
    const html = renderToStaticMarkup(<LessonSummaryScreen subjectId="subj-1" />);
    expect(html).toContain('href="/subject/subj-1"');
    expect(html).not.toContain("/parent/subjects/");
  });
});
