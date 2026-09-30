import { describe, expect, it } from "vitest";
import { daysInMonth, familyDateParts, monthKey } from "./time";

describe("familyDateParts (ADR-035, ADR-012 month-in-family-timezone rule)", () => {
  it("resolves the family's local date, which can differ from UTC", () => {
    // 2026-09-30 23:30 UTC is already 2026-10-01 in Kyiv (UTC+3 in autumn... actually +2/+3 DST-dependent);
    // use a Pacific timezone instead, where the local date is unambiguously still 2026-09-30.
    const d = new Date("2026-10-01T02:30:00Z");
    expect(familyDateParts(d, "America/Los_Angeles")).toEqual({ year: 2026, month: 9, day: 30 });
    expect(familyDateParts(d, "UTC")).toEqual({ year: 2026, month: 10, day: 1 });
  });
});

describe("monthKey", () => {
  it("pads the month to match spend_months.month ('YYYY-MM')", () => {
    expect(monthKey({ year: 2026, month: 9 })).toBe("2026-09");
    expect(monthKey({ year: 2026, month: 12 })).toBe("2026-12");
  });
});

describe("daysInMonth", () => {
  it("knows short months and leap Februaries", () => {
    expect(daysInMonth({ year: 2026, month: 9 })).toBe(30);
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
  });
});
