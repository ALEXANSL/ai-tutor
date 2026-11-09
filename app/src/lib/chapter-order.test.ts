import { expect, it } from "vitest";
import { orderChapterLessons } from "./chapter-order";
it("orders unnamed literature lessons by book page, with stable same-page parts", () => {
  const input = [{ title: "Євшан-зілля", page: 70, order: 3 }, { title: "Вступ", order: 0 }, { title: "Народна пісня", page: 10, order: 1 }, { title: "Народна пісня. Частина 2", page: 10, order: 2 }];
  expect(orderChapterLessons(input, item => item).map(item => item.title)).toEqual(["Вступ", "Народна пісня", "Народна пісня. Частина 2", "Євшан-зілля"]);
  expect(input[0]?.title).toBe("Євшан-зілля");
});
it("uses saved lesson order when pages are missing and preserves other book slots", () => {
  const input = [{ title: "А", packageId: "book1", order: 8 }, { title: "Інший підручник", packageId: "book2", order: 1 }, { title: "Б", packageId: "book1", order: 2 }];
  expect(orderChapterLessons(input, item => item)).toEqual([input[2], input[1], input[0]]);
});
it("retains explicit paragraph sorting and never interprets dates as lesson numbers", () => {
  expect(orderChapterLessons([{ title: "§20", order: 1, page: 10 }, { title: "§2", order: 2, page: 90 }], item => item).map(item => item.title)).toEqual(["§2", "§20"]);
  const input = [{ title: "Події 1914 року" }, { title: "Життя у 988 році" }];
  expect(orderChapterLessons(input, item => item)).toEqual(input);
});
