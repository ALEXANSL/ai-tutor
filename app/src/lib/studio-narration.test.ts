import { expect, it } from "vitest";
import { studioNarrationText } from "./studio-narration";
import { splitNarrationParts } from "./narration-parts";
it("speaks the whole visible Ukrainian explanation rather than a short model synopsis", () => {
 const text="# Цифровий слід\n\n**Перший приклад.**\n\nДругий приклад, який не можна пропустити.";
 expect(studioNarrationText({kind:"explanation",text,narration:"Коротко."})).toBe("Цифровий слід\n\nПерший приклад.\n\nДругий приклад, який не можна пропустити.");
});
it("reads table column meanings with every cell and retains examples", () => {
 const text="| Дані | Дія |\n|---|---|\n| Пароль | Не передавати |\n| Фото | Перевірити фон |";
 const speech=studioNarrationText({kind:"example",text}); expect(speech).toContain("Дані: Пароль. Дія: Не передавати.");expect(speech).toContain("Дані: Фото. Дія: Перевірити фон.");
});
it("preserves authored code explanations and foreign-language narration", () => {
 expect(studioNarrationText({kind:"code",text:"print(1)",narration:"Програма показує один."})).toBe("Програма показує один.");
 expect(studioNarrationText({kind:"example",text:"Привіт",narration:"Guten Tag!",narrationLanguage:"de-DE"})).toBe("Guten Tag!");
});
it("splits long speech losslessly without cutting a sentence or losing the tail", () => {
 const text="Речення з поясненням. ".repeat(500)+"Остання важлива думка.";const parts=splitNarrationParts(text);
 expect(parts.length).toBeGreaterThan(1);expect(parts.every(part=>part.length<=3500)).toBe(true);expect(parts.join("")).toBe(text);expect(parts.at(-1)).toContain("Остання важлива думка.");
});
it("does not split surrogate pairs when there are no word boundaries",()=>{const text="🙂".repeat(4001),parts=splitNarrationParts(text);expect(parts.join("")).toBe(text);expect(parts.every(part=>!/[\uD800-\uDBFF]$/.test(part))).toBe(true);});
