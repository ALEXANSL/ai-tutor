import { describe, expect, it } from "vitest";
import { dayPartForHour, hourInTimeZone } from "./dayPart";

describe("hourInTimeZone", () => {
  it("reads the hour in the given timezone, not the server's own", () => {
    // 2026-01-15T22:30:00Z is 2026-01-16T00:30 in Kyiv (UTC+2 in January).
    const date = new Date("2026-01-15T22:30:00Z");
    expect(hourInTimeZone(date, "UTC")).toBe(22);
    expect(hourInTimeZone(date, "Europe/Kyiv")).toBe(0);
  });

  it("returns midnight as 0, not 24", () => {
    expect(hourInTimeZone(new Date("2026-01-15T00:05:00Z"), "UTC")).toBe(0);
  });
});

describe("dayPartForHour", () => {
  it.each([
    [0, "night"],
    [4, "night"],
    [5, "morning"],
    [11, "morning"],
    [12, "day"],
    [17, "day"],
    [18, "evening"],
    [22, "evening"],
    [23, "night"],
  ])("hour %i is %s", (hour, expected) => {
    expect(dayPartForHour(hour)).toBe(expected);
  });
});
