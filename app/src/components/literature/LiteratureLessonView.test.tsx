// @vitest-environment jsdom
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PO correction 2026-10-02: "обов'язково кнопка пропустити завдання в
 * уроці, з нагадуванням, що урок не буде зараховано" — the "Пропустити"
 * button on `LiteratureTest` is now ALWAYS shown next to "Перевірити" on
 * every question (no longer gated by a parent-settings toggle), and clicking
 * it must first show a confirmation warning that the lesson won't count; it
 * only skips when that confirmation is accepted. A real interactive (jsdom)
 * test, same style as `LessonRunner.test.tsx`: it clicks the actual button
 * and asserts the explanation reveals without a correct/incorrect verdict
 * (same no-verdict path as `open`/`match`/`order`).
 */
const { LiteratureTest, LiteratureLessonScreen } = await import("./LiteratureLessonView");

const questions = [
  {
    id: "q1",
    type: "single" as const,
    questionUk: "Хто написав «Ніч перед Різдвом»?",
    options: ["Гоголь", "Шевченко"],
    answer: 0,
    explanationUk: "Автор — Микола Гоголь.",
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<LiteratureTest questions={questions} />);
  });
  return container!;
}

describe("LiteratureTest skip button (PO correction 2026-10-02)", () => {
  it("always renders a skip button (not gated by any setting)", () => {
    const el = render();
    expect(Array.from(el.querySelectorAll("button")).some((b) => b.textContent === "Пропустити")).toBe(true);
  });

  it("does nothing when the skip warning is not confirmed", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const el = render();
    const skipBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Пропустити")!;
    act(() => {
      skipBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(confirmSpy).toHaveBeenCalledWith("Якщо пропустиш — цей урок не буде зараховано як пройдений. Пропустити?");
    expect(el.textContent).not.toContain("Автор — Микола Гоголь.");
    confirmSpy.mockRestore();
  });

  it("clicking skip warns, then (once confirmed) reveals the explanation without scoring it as right/wrong", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const el = render();
    const skipBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Пропустити")!;
    act(() => {
      skipBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(confirmSpy).toHaveBeenCalledWith("Якщо пропустиш — цей урок не буде зараховано як пройдений. Пропустити?");
    expect(el.textContent).toContain("Автор — Микола Гоголь.");
    // No score line should appear — `scored` only grows from a verdict, not from a skip (onAnswered(null)).
    expect(el.textContent).not.toContain("Правильно:");
    confirmSpy.mockRestore();
  });

  it("checking a correct answer still shows the score line (sanity: skip ≠ regular check)", () => {
    const el = render();
    const radio = el.querySelector('input[type="radio"]') as HTMLInputElement;
    act(() => {
      radio.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const checkBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Перевірити")!;
    act(() => {
      checkBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Правильно: 1 з 1");
  });
});

/**
 * PO correction 2026-10-01: `/literature/book/[materialId]` is just a bare
 * topic list, not a "read the book" page. PO correction 2026-10-02: reading
 * the book must be a fully SEPARATE action, not embedded inside the lesson
 * screen — the lesson now just links out to the real reader at
 * `/book/[materialId]`, replacing the old inline full-text-reveal panel.
 */
describe("LiteratureLessonScreen read-the-book link (PO corrections 2026-10-01/02)", () => {
  const baseLesson = {
    id: "lesson-1",
    materialId: "material-42",
    topicNo: 1,
    sectionTitle: null,
    title: "Микола Гоголь. «Ніч перед Різдвом»",
    textbookPageFrom: 10,
    textbookPageTo: 20,
    pdfPageFrom: null,
    pdfPageTo: null,
    goalUk: "Ознайомити з повістю.",
    keyConcepts: [],
    explanationMd: "Матеріал для пояснення.",
    work: {
      titleUk: "Ніч перед Різдвом",
      excerptsUk: "«Останній день перед Різдвом минув.»",
      summaryUk: "Коротко про сюжет.",
      charactersUk: null,
      ideaUk: null,
      authorBioUk: null,
      otherWorksUk: null,
    },
    sublessons: [],
    teacherNoteUk: "",
    status: "active" as const,
    test: [],
    workFullTextDriveFileId: "drive-file-1",
  };

  function renderScreen() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<LiteratureLessonScreen lesson={baseLesson} />);
    });
    return container!;
  }

  it("never links to /literature/book/[materialId] as a reader", () => {
    const el = renderScreen();
    expect(el.innerHTML).not.toContain(`/literature/book/${baseLesson.materialId}`);
  });

  it("links out to the real PDF reader at /book/[materialId]", () => {
    const el = renderScreen();
    const link = Array.from(el.querySelectorAll("a")).find((a) => a.textContent?.includes("Читати книгу"));
    expect(link?.getAttribute("href")).toBe(`/book/${baseLesson.materialId}`);
  });
});
