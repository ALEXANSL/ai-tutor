import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Nav review (2026-09-27), finding #2: the "Готуємо урок…" cold-start screen
// (a real wait of 1-3+ minutes, ADR-023) had no way back at all — the same
// class of dead-end BUG-025 already fixed on `LessonPicker`/
// `LessonPausedScreen`. This asserts the same two links now render here too.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

import { LibraryWarmProgress } from "./LibraryWarmProgress";

describe("LibraryWarmProgress", () => {
  it("renders links back to /today and the subject's lesson list", () => {
    const html = renderToStaticMarkup(
      <LibraryWarmProgress sessionId="s1" subjectId="subj-1" subjectName="Математика" topicTitle="Дроби" />,
    );
    expect(html).toContain('href="/today"');
    expect(html).toContain('href="/subject/subj-1"');
  });

  // Reported: "не зрозуміло який урок ми готуємо" — the child/parent had no
  // way to tell which subject/topic this wait was even for.
  it("shows which subject and topic are being prepared", () => {
    const html = renderToStaticMarkup(
      <LibraryWarmProgress sessionId="s1" subjectId="subj-1" subjectName="Математика" topicTitle="Дроби" />,
    );
    expect(html).toContain("Математика");
    expect(html).toContain("Дроби");
  });
});
