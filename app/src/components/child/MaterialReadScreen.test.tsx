import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MaterialReadScreen } from "./MaterialReadScreen";

/**
 * PO bug report ("сторінки скачуть по всьому екрану"): the prev/next/page
 * indicator must be in a sticky bar at the top, not below content, plus a
 * "jump to…" fallback for a missing table of contents, and an honest note
 * when some scanned pages failed OCR (D-105 follow-up).
 */
describe("MaterialReadScreen", () => {
  const chunks = [
    { id: "c1", sectionTitle: "Розділ 1", page: 1, text: "Перший текст" },
    { id: "c2", sectionTitle: "Розділ 1", page: 2, text: "Другий текст" },
    { id: "c3", sectionTitle: "Розділ 2", page: 5, text: "Третій текст" },
  ];

  it("renders the nav bar as sticky, above the content, clear of the ThemeToggle's fixed top-right corner", () => {
    const html = renderToStaticMarkup(
      <MaterialReadScreen materialId="m1" materialTitle="Книга" chunks={chunks} initialMessages={[]} />,
    );
    expect(html).toContain("sticky");
    // Not top-0: (child)/layout.tsx's ThemeToggle is `fixed top-3.5
    // right-3.5 z-50`, above this bar's z-40, and its footprint's bottom
    // edge sits ~58px down — top-20 (80px) keeps this bar's right-aligned
    // "Далі" button from ever landing under it.
    expect(html).toContain("top-20");
    expect(html).not.toContain("top-0");
  });

  it("builds a jump list grouped by section (fallback for a missing table of contents)", () => {
    const html = renderToStaticMarkup(
      <MaterialReadScreen materialId="m1" materialTitle="Книга" chunks={chunks} initialMessages={[]} />,
    );
    expect(html).toContain("<option");
    expect(html).toContain("Розділ 2");
    // Two chunks share "Розділ 1" -> only one <option> for it (plus the
    // current chunk's own section heading rendered above the text).
    expect(html.match(/Розділ 1/g)?.length).toBe(2);
  });

  it("falls back to page-number jump targets when there is no section title", () => {
    const html = renderToStaticMarkup(
      <MaterialReadScreen
        materialId="m1"
        materialTitle="Книга"
        chunks={[
          { id: "c1", sectionTitle: null, page: 1, text: "a" },
          { id: "c2", sectionTitle: null, page: 2, text: "b" },
        ]}
        initialMessages={[]}
      />,
    );
    expect(html).toContain("Стор. 1");
    expect(html).toContain("Стор. 2");
  });

  it("still lists a chunk missing a section title individually, by page number, in an otherwise section-grouped material", () => {
    // Realistic for partially-OCR'd/TOC-detected books: some chunks got a
    // detected sectionTitle, some didn't. Those without one must not be
    // silently dropped from the jump list.
    const html = renderToStaticMarkup(
      <MaterialReadScreen
        materialId="m1"
        materialTitle="Книга"
        chunks={[
          { id: "c1", sectionTitle: "Розділ 1", page: 1, text: "a" },
          { id: "c2", sectionTitle: null, page: 2, text: "b" },
          { id: "c3", sectionTitle: null, page: 3, text: "c" },
          { id: "c4", sectionTitle: "Розділ 2", page: 4, text: "d" },
        ]}
        initialMessages={[]}
      />,
    );
    expect(html).toContain("<option");
    expect(html).toContain("Розділ 1");
    expect(html).toContain("Розділ 2");
    // c2 and c3 have no sectionTitle -> each still gets its own reachable
    // option, labelled by page number.
    expect(html).toContain("Стор. 2");
    expect(html).toContain("Стор. 3");
  });

  it("hides the jump select entirely when there is only one page/section", () => {
    const html = renderToStaticMarkup(
      <MaterialReadScreen materialId="m1" materialTitle="Книга" chunks={[chunks[0]!]} initialMessages={[]} />,
    );
    expect(html).not.toContain("<select");
  });

  it("shows a note when the material was only partially recognised (some OCR pages missing)", () => {
    const html = renderToStaticMarkup(
      <MaterialReadScreen materialId="m1" materialTitle="Книга" chunks={chunks} initialMessages={[]} partiallyIndexed />,
    );
    expect(html).toContain("не вдалося розпізнати");
  });

  it("does not show the note by default", () => {
    const html = renderToStaticMarkup(
      <MaterialReadScreen materialId="m1" materialTitle="Книга" chunks={chunks} initialMessages={[]} />,
    );
    expect(html).not.toContain("не вдалося розпізнати");
  });
});
