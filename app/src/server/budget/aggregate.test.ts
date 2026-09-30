import { describe, expect, it } from "vitest";
import {
  breakdownByProvider,
  breakdownByRole,
  dailyTrend,
  errorFallbackSummary,
  forecastMonthSpend,
  type SpendCallInput,
} from "./aggregate";

const call = (over: Partial<SpendCallInput> = {}): SpendCallInput => ({
  role: "lesson_generation",
  provider: "anthropic",
  costUsd: 1,
  status: "ok",
  fallbackUsed: false,
  day: 1,
  ...over,
});

describe("forecastMonthSpend (ADR-035 §1, linear extrapolation)", () => {
  it("extrapolates the daily rate over the whole month", () => {
    // $20 spent over 10 days of a 30-day month -> $2/day -> $60 forecast.
    const r = forecastMonthSpend({ spentUsd: 20, limitUsd: 100, daysElapsed: 10, daysInMonth: 30 });
    expect(r.forecastUsd).toBeCloseTo(60);
    expect(r.pctOfLimit).toBeCloseTo(20);
    expect(r.pctForecastOfLimit).toBeCloseTo(60);
  });

  it("never divides by zero on day 1 or an empty month", () => {
    expect(() => forecastMonthSpend({ spentUsd: 5, limitUsd: 100, daysElapsed: 0, daysInMonth: 30 })).not.toThrow();
    const r = forecastMonthSpend({ spentUsd: 5, limitUsd: 100, daysElapsed: 0, daysInMonth: 30 });
    expect(Number.isFinite(r.forecastUsd)).toBe(true);
  });

  it("treats a missing/zero limit as 0 %, not NaN or Infinity", () => {
    const r = forecastMonthSpend({ spentUsd: 5, limitUsd: 0, daysElapsed: 5, daysInMonth: 30 });
    expect(r.pctOfLimit).toBe(0);
    expect(r.pctForecastOfLimit).toBe(0);
  });

  it("caps daysElapsed to the month length (e.g. a stale limit row from a previous, longer month)", () => {
    const r = forecastMonthSpend({ spentUsd: 30, limitUsd: 100, daysElapsed: 40, daysInMonth: 28 });
    expect(r.daysElapsed).toBe(28);
    expect(r.forecastUsd).toBeCloseTo(30);
  });
});

describe("breakdownByRole / breakdownByProvider (ADR-035 §2)", () => {
  const label = (k: string) => `label:${k}`;

  it("groups cost and call count by key, sorted by cost desc", () => {
    const calls = [
      call({ role: "lesson_generation", costUsd: 3 }),
      call({ role: "ocr_page", costUsd: 10 }),
      call({ role: "lesson_generation", costUsd: 2 }),
    ];
    const rows = breakdownByRole(calls, label);
    expect(rows).toEqual([
      { key: "ocr_page", label: "label:ocr_page", costUsd: 10, callCount: 1, pctOfTotal: (10 / 15) * 100 },
      { key: "lesson_generation", label: "label:lesson_generation", costUsd: 5, callCount: 2, pctOfTotal: (5 / 15) * 100 },
    ]);
  });

  it("returns an empty list for no calls, never NaN percentages", () => {
    expect(breakdownByRole([], label)).toEqual([]);
  });

  it("groups by provider the same way", () => {
    const calls = [call({ provider: "anthropic", costUsd: 4 }), call({ provider: "openai", costUsd: 1 })];
    const rows = breakdownByProvider(calls, label);
    expect(rows.map((r) => r.key)).toEqual(["anthropic", "openai"]);
  });
});

describe("dailyTrend (ADR-035 §4)", () => {
  it("fills every day up to daysElapsed, 0 for days with no calls", () => {
    const calls = [call({ day: 1, costUsd: 2 }), call({ day: 3, costUsd: 1 }), call({ day: 1, costUsd: 1 })];
    const points = dailyTrend(calls, 4);
    expect(points).toEqual([
      { day: 1, costUsd: 3 },
      { day: 2, costUsd: 0 },
      { day: 3, costUsd: 1 },
      { day: 4, costUsd: 0 },
    ]);
  });

  it("returns an empty series when daysElapsed is 0", () => {
    expect(dailyTrend([call()], 0)).toEqual([]);
  });
});

describe("errorFallbackSummary (ADR-035 §5)", () => {
  it("counts errors and fallbacks independently", () => {
    const calls = [
      call({ status: "ok", fallbackUsed: false }),
      call({ status: "error", fallbackUsed: false }),
      call({ status: "ok", fallbackUsed: true }),
      call({ status: "error", fallbackUsed: true }),
    ];
    expect(errorFallbackSummary(calls)).toEqual({ totalCalls: 4, errorCount: 2, fallbackCount: 2 });
  });

  it("is all zero for no calls", () => {
    expect(errorFallbackSummary([])).toEqual({ totalCalls: 0, errorCount: 0, fallbackCount: 0 });
  });
});
