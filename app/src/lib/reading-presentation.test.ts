import { expect, it } from "vitest";
import { hasReadingExtractionArtifacts, preferredReadingLayout } from "./reading-presentation";
it("uses verse metadata and otherwise prose, without guessing from the text", () => {
  expect(preferredReadingLayout("poem_fragment")).toBe("lines");
  expect(preferredReadingLayout("", "вірш")).toBe("lines");
  expect(preferredReadingLayout("textbook_page_transcription", "навчальний текст і уривки твору")).toBe("paragraphs");
});
it("flags the supplied page's column padding and broken glyph pattern, without flagging ordinary verse or units", () => {
  expect(hasReadingExtractionArtifacts("у всіх куточках світу            Людмила")).toBe(true);
  expect(hasReadingExtractionArtifacts("М³фи на вс³ часи")).toBe(true);
  expect(hasReadingExtractionArtifacts("Перший рядок\n    Другий рядок\n\nОб’єм — 5 см³.")).toBe(false);
});
