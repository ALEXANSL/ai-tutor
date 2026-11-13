import { expect, it } from "vitest";
import { trimAudioParagraph, joinIndexedAudioPage } from "./paragraph-source";
it("cuts both neighbours on one shared textbook page and preserves the actual selected text", () => {
  const text = "Матеріал попереднього параграфа\n§ 16. Теплові явища\nНагрівання змінює розміри тіл.\n§17. Електричні явища\nТекст наступної теми";
  const result = trimAudioParagraph([{ page: 86, text, locator: null }], "§16. Теплові явища", "§17. Електричні явища");
  expect(result[0]!.text).toContain("Нагрівання"); expect(result[0]!.text).not.toContain("попереднього"); expect(result[0]!.text).not.toContain("Електричні");
});
it("retains intermediate pages and handles a wrapped heading", () => {
  const result = trimAudioParagraph([{ page: 1, locator: null, text: "Інша тема\n§16. Теплові\nявища\nПояснення" }, { page: 2, locator: null, text: "Продовження без скорочень" }], "Теплові явища");
  expect(result[1]!.text).toBe("Продовження без скорочень"); expect(result[0]!.text).not.toContain("Інша тема");
});
it("does not claim exact paragraph boundaries when the start or shared-page end is absent", () => {
  const units = [{ page: 1, locator: null, text: "§16. Теплові явища\nПояснення" }];
  expect(() => trimAudioParagraph(units, "Невідомий заголовок")).toThrow("початок");
  expect(() => trimAudioParagraph(units, "Теплові явища", "Наступний параграф")).toThrow("наступний");
});
it("removes indexed short chunk overlap without losing the following content", () => {
  const ending = "Завершення речення першого фрагмента про природу, його зміст і важливий висновок. ".repeat(2).trim();
  const result = joinIndexedAudioPage([`Початок сторінки. ${ending}`, `${ending} Далі йде новий текст.`]);
  expect(result).toBe(`Початок сторінки. ${ending}\n\nДалі йде новий текст.`);
});
