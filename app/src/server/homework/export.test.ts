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

const visual = { kind: "sequence" as const, title: "Як діяти при кібербулінгу", caption: "Послідовність допомагає припинити небезпечне спілкування й отримати допомогу дорослого.", unit: "", items: [{ label: "Зупини розмову", detail: "Не відповідай образами.", value: null }, { label: "Збережи докази", detail: "Зроби скриншот повідомлень.", value: null }, { label: "Звернися по допомогу", detail: "Покажи повідомлення дорослому.", value: null }] };
const table = { title: "Що можна публікувати", columns: ["Можна обережно", "Не публікуємо"], rows: [["Власний малюнок", "Паролі"], ["Фото природи", "Домашню адресу"]] };
it("embeds an actual PNG infographic, accessible captions and native editable tables into DOCX", async () => {
  const work = homeworkFixture(); Object.assign(work.result!.artifact!.sections[0]!, { visuals: [visual], tables: [table] });
  const files = unzipSync(await exportHomework(work, "docx")); const document = xml(files, "word/document.xml");
  expect(document).toContain("<w:tbl>"); expect(document).toContain("<w:drawing>"); expect(document).toContain("Як діяти при кібербулінгу"); expect(document).toContain("Зроби скриншот");
  const image = Object.entries(files).find(([name]) => name.startsWith("word/media/") && name.endsWith(".png"))![1]; expect([...image.slice(0, 4)]).toEqual([137, 80, 78, 71]);
});
it("embeds editable diagram labels and details and a PowerPoint table while retaining speaker explanations", async () => {
  const work = homeworkFixture(); work.result!.artifact!.slides = [{ title: "Дії при небезпеці", bullets: ["Проси допомоги дорослого"], notes: "Не потрібно залишатися з проблемою наодинці. ".repeat(5), visual }, { title: "Дані", bullets: ["Порівняй дві групи"], notes: "Поясни обмеження", table }];
  const files = unzipSync(await exportHomework(work, "pptx")); expect(xml(files, "ppt/slides/slide1.xml")).toContain("Зроби скриншот повідомлень."); expect(xml(files, "ppt/slides/slide1.xml")).toContain("Зупини розмову");
  expect(xml(files, "ppt/slides/slide2.xml")).toContain("<a:tbl>"); expect(xml(files, "ppt/notesSlides/notesSlide1.xml")).toContain("Не потрібно залишатися");
});
it("marks a structurally incomplete deliverable as a draft inside the exported files", async () => {
  const work = homeworkFixture(); work.result!.quality = { status: "draft", issues: ["Потрібна карта"] };
  const files = unzipSync(await exportHomework(work, "docx")); expect(xml(files, "word/document.xml")).toContain("ЧЕРНЕТКА"); expect(xml(files, "word/document.xml")).toContain("Потрібна карта");
});

it("keeps three short visual takeaways on their slide instead of making a one-line continuation", () => {
 const slides = paginateSlides([{title:"Цифровий слід", visual, bullets:["Це відомості після наших дій", "Вони утворюють портрет", "Інтернет пам’ятає більше"], notes:"Розгорнуте пояснення"}]);
 expect(slides).toHaveLength(1); expect(slides[0]!.bullets).toHaveLength(3);
});
