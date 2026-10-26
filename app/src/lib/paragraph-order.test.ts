import { describe, expect, it } from "vitest";
import { leadingParagraphNumber, orderParagraphs } from "./paragraph-order";
describe("read-time textbook paragraph ordering", () => {
  it("sorts numbers naturally, including ranges and mixed prefixes", () => {
    const input = ["§ 10. Тема", "Параграф 2. Тема", "§ 20. Тема", "§18–19. Тема", "§ 9. Тема"];
    expect(orderParagraphs(input, title => title)).toEqual([input[1], input[4], input[0], input[3], input[2]]);
    expect(input[0]).toBe("§ 10. Тема");
  });
  it("retains unnumbered lesson positions and repeated-number order", () => {
    const input = ["Вступ", "§ 20. А", "Повторення", "§ 2. Б", "§ 2. В", "Підсумок"];
    expect(orderParagraphs(input, title => title)).toEqual(["Вступ", "§ 2. Б", "Повторення", "§ 2. В", "§ 20. А", "Підсумок"]);
  });
  it.each(["Події 1914 року", "Урок 10", "Задача 357", "§ 99999999999999999999999. Тема", "§ 2abc", "Розділ 3"])("does not guess from %s", title => {
    expect(leadingParagraphNumber(title)).toBeNull();
  });
  it("leaves other lesson systems in their existing slots", () => {
    const items = [{ id: "v3-20", title: "§20" }, { id: "old", title: "§1" }, { id: "v3-2", title: "§2" }];
    expect(orderParagraphs(items, item => item.title, item => item.id.startsWith("v3"))).toEqual([items[2], items[1], items[0]]);
  });
});
