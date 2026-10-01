// @vitest-environment jsdom
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PO feedback 2026-10-01: "зроби кнопку яку можна показувати/ховати з
 * налаштувань - пропустити тести" — the `allowSkip` prop on `LiteratureTest`
 * gates a "Пропустити" button next to "Перевірити" on every question. A
 * real interactive (jsdom) test, same style as `LessonRunner.test.tsx`: it
 * clicks the actual button and asserts the explanation reveals without a
 * correct/incorrect verdict (same no-verdict path as `open`/`match`/`order`).
 */
vi.mock("@/app/actions/literature", () => ({
  getLiteratureWorkFullTextAction: vi.fn(),
}));

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

function render(allowSkip: boolean) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<LiteratureTest questions={questions} allowSkip={allowSkip} />);
  });
  return container!;
}

describe("LiteratureTest skip button (PO feedback 2026-10-01)", () => {
  it("does not render a skip button when allowSkip is false (default)", () => {
    const el = render(false);
    expect(Array.from(el.querySelectorAll("button")).some((b) => b.textContent === "Пропустити")).toBe(false);
  });

  it("renders a skip button when allowSkip is true", () => {
    const el = render(true);
    expect(Array.from(el.querySelectorAll("button")).some((b) => b.textContent === "Пропустити")).toBe(true);
  });

  it("clicking skip reveals the explanation without scoring it as right/wrong", () => {
    const el = render(true);
    const skipBtn = Array.from(el.querySelectorAll("button")).find((b) => b.textContent === "Пропустити")!;
    act(() => {
      skipBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).toContain("Автор — Микола Гоголь.");
    // No score line should appear — `scored` only grows from a verdict, not from a skip (onAnswered(null)).
    expect(el.textContent).not.toContain("Правильно:");
  });

  it("checking a correct answer still shows the score line (sanity: skip ≠ regular check)", () => {
    const el = render(true);
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
 * topic list, not a "read the book" page — the lesson screen must NOT link
 * to it as a reader. The inline `WorkFullTextReveal` (fed from the family's
 * own Drive) is the one real full-text affordance, now a bigger, clearer
 * "📖 Читати повний текст твору" panel rather than a cramped toggle.
 */
describe("LiteratureLessonScreen full-text reveal (PO correction 2026-10-01)", () => {
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

  it("shows the big 'Читати повний текст твору' button when the Drive file is available", () => {
    const el = renderScreen();
    expect(Array.from(el.querySelectorAll("button")).some((b) => b.textContent?.includes("Читати повний текст твору"))).toBe(true);
  });
});
