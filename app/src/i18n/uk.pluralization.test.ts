import { describe, expect, it } from "vitest";
import { uk } from "./uk";

/**
 * QA bug (commit 4ce0cfe): `ocrUnreadableValue` used a naive
 * `n === 1 ? singular : plural`, which produced "2 сторінок" /
 * "3 сторінок" / "4 сторінок" instead of the correct "сторінки".
 * Standard Slavic three-way plural: one (1, 21, 31…), few (2-4, 22-24…),
 * many (0, 5-20, 25-30…).
 */
describe("uk.parent.books.detail.ocrUnreadableValue: Ukrainian plural rules", () => {
  const value = uk.parent.books.detail.ocrUnreadableValue;

  it("uses the 'one' form for n=1, 21, 31 (but not 11)", () => {
    expect(value(1)).toContain("1 сторінку");
    expect(value(21)).toContain("21 сторінку");
    expect(value(31)).toContain("31 сторінку");
    expect(value(11)).not.toContain("сторінку ");
  });

  it("uses the 'few' form for n=2,3,4 and 22,23,24 (not 12,13,14)", () => {
    expect(value(2)).toContain("2 сторінки");
    expect(value(3)).toContain("3 сторінки");
    expect(value(4)).toContain("4 сторінки");
    expect(value(22)).toContain("22 сторінки");
    expect(value(23)).toContain("23 сторінки");
    expect(value(24)).toContain("24 сторінки");
    expect(value(12)).not.toContain("сторінки");
    expect(value(13)).not.toContain("сторінки");
    expect(value(14)).not.toContain("сторінки");
  });

  it("uses the 'many' form for 0, 5-20, 25-30, and the 11-14 teens", () => {
    expect(value(0)).toContain("0 сторінок");
    expect(value(5)).toContain("5 сторінок");
    expect(value(11)).toContain("11 сторінок");
    expect(value(12)).toContain("12 сторінок");
    expect(value(13)).toContain("13 сторінок");
    expect(value(14)).toContain("14 сторінок");
    expect(value(20)).toContain("20 сторінок");
    expect(value(25)).toContain("25 сторінок");
  });
});
