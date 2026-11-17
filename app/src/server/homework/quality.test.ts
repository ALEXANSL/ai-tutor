import { expect, it } from "vitest";
import { homeworkQuality } from "./quality";
import { homeworkFixture } from "./__fixtures__/work";
it("distinguishes a thin report from a complete response without imposing a report length on a simple answer", () => {
  const result = homeworkFixture().result!;
  expect(homeworkQuality(result, "docx", "Підготуй реферат про безпеку").status).toBe("draft");
  expect(homeworkQuality(result, "docx", "Відповідь на одне запитання").status).toBe("ready");
  expect(homeworkQuality(result, "docx", "Коротке есе на 100 слів").status).toBe("ready");
});
it("does not claim that an infographic fulfills a requested photograph or map", () => {
  const result = homeworkFixture().result!; result.artifact!.sections[0]!.visuals = [{ kind: "concept", title: "Безпека", caption: "Основні поняття", unit: "", items: [{ label: "Пароль", detail: "Захищай", value: null }, { label: "Приватність", detail: "Обмежуй", value: null }] }];
  expect(homeworkQuality(result, "docx", "Додай фото і карту України").status).toBe("draft");
});
it("requires substantive presentation notes and a meaningful visual unless text-only was explicitly requested", () => {
  const result = homeworkFixture().result!; result.artifact!.slides = Array.from({ length: 4 }, () => ({ title: "Тема", bullets: ["Змістовна думка"], notes: "Повне пояснення з прикладом і причинним зв’язком. ".repeat(4) }));
  expect(homeworkQuality(result, "pptx", "Презентація про безпеку").status).toBe("draft");
  expect(homeworkQuality(result, "pptx", "Лише текстова презентація без схем").status).toBe("ready");
});

it("does not confuse photosynthesis or an explicit no-photo instruction with a request for a photograph", () => {
  const result = homeworkFixture().result!;
  expect(homeworkQuality(result, "docx", "Поясни фотосинтез").status).toBe("ready");
  expect(homeworkQuality(result, "docx", "Короткий текст про рослини без фото").status).toBe("ready");
  result.artifact!.unresolvedRequirements = ["Для аналізу потрібна репродукція твору"];
  expect(homeworkQuality(result, "docx", "Поясни картину").status).toBe("draft");
});
