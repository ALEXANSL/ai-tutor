import { expect, it } from "vitest";
import { unzipSync } from "fflate";
import { exportHomework, paginateSlides } from "./export";
import { homeworkFixture } from "./__fixtures__/work";
const xml = (files: Record<string, Uint8Array>, name: string) => new TextDecoder().decode(files[name]);
it("creates an editable DOCX with Ukrainian paragraphs, headings and page numbers without macros", async () => {
  const work = homeworkFixture(); work.result!.artifact!.sections[0]!.paragraphs.push('<script>alert("x")</script>');
  const files = unzipSync(await exportHomework(work, "docx")); const document = xml(files, "word/document.xml");
  expect(document).toContain("Безпека в соціальних мережах"); expect(document).toContain("Що варто берегти"); expect(document).toContain("&lt;script&gt;"); expect(document).not.toContain("<script>");
  expect(document).toContain("сторінки: 75"); expect(Object.keys(files).some(path => /vbaProject/i.test(path))).toBe(false);
  expect(xml(files, "word/footer1.xml")).toContain("PAGE");
});
it("creates a real PowerPoint with editable text and speaker notes", async () => {
  const files = unzipSync(await exportHomework(homeworkFixture(), "pptx"));
  expect(xml(files, "ppt/slides/slide1.xml")).toContain("Безпечне спілкування");
  expect(xml(files, "ppt/slides/slide1.xml")).toContain("Не поширюй паролі");
  expect(xml(files, "ppt/notesSlides/notesSlide1.xml")).toContain("Поясни, чому пароль");
  expect(Object.keys(files).some(path => /vbaProject/i.test(path))).toBe(false);
});
it("paginates dense slides without dropping text and refuses absent requested content", async () => {
  const bullets = Array.from({ length: 8 }, (_, index) => `${index}: ${"Довга теза ".repeat(35)}`);
  const pages = paginateSlides([{ title: "Приклади", bullets, notes: "Нотатки" }]);
  expect(pages.length).toBeGreaterThan(1); expect(pages.flatMap(page => page.bullets)).toEqual(bullets);
  const work = homeworkFixture(); work.result!.artifact!.slides = [];
  await expect(exportHomework(work, "pptx")).rejects.toThrow("PowerPoint");
});
