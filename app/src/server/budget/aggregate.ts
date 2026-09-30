/**
 * Pure cost-aggregation logic for the budget dashboard (ADR-035). No I/O, no
 * timezone handling here — `queries.ts` fetches rows and resolves per-family
 * timezone, this module only does arithmetic, so it is trivial to unit test.
 */

export interface SpendCallInput {
  role: string;
  provider: string;
  costUsd: number;
  status: "ok" | "error";
  fallbackUsed: boolean;
  /** 1-based day of month, already resolved in the family's timezone. */
  day: number;
}

export interface ForecastInput {
  spentUsd: number;
  limitUsd: number;
  /** 1-based day of month "today" is, in the family's timezone. */
  daysElapsed: number;
  daysInMonth: number;
}

export interface ForecastResult {
  spentUsd: number;
  limitUsd: number;
  /** Linear extrapolation from the daily rate so far to the full month. */
  forecastUsd: number;
  pctOfLimit: number;
  pctForecastOfLimit: number;
  daysElapsed: number;
  daysInMonth: number;
}

/** Linear extrapolation from days-elapsed — intentionally simple (ADR-035). */
export function forecastMonthSpend({ spentUsd, limitUsd, daysElapsed, daysInMonth }: ForecastInput): ForecastResult {
  const safeDaysElapsed = Math.min(Math.max(daysElapsed, 1), Math.max(daysInMonth, 1));
  const dailyRate = spentUsd / safeDaysElapsed;
  const forecastUsd = dailyRate * daysInMonth;
  const pctOfLimit = limitUsd > 0 ? (spentUsd / limitUsd) * 100 : 0;
  const pctForecastOfLimit = limitUsd > 0 ? (forecastUsd / limitUsd) * 100 : 0;
  return { spentUsd, limitUsd, forecastUsd, pctOfLimit, pctForecastOfLimit, daysElapsed: safeDaysElapsed, daysInMonth };
}

export interface BreakdownItem {
  key: string;
  label: string;
  costUsd: number;
  callCount: number;
  pctOfTotal: number;
}

function groupBy(calls: SpendCallInput[], keyFn: (c: SpendCallInput) => string, labelOf: (key: string) => string): BreakdownItem[] {
  const totals = new Map<string, { cost: number; count: number }>();
  let total = 0;
  for (const c of calls) {
    const key = keyFn(c);
    const entry = totals.get(key) ?? { cost: 0, count: 0 };
    entry.cost += c.costUsd;
    entry.count += 1;
    totals.set(key, entry);
    total += c.costUsd;
  }
  return [...totals.entries()]
    .map(([key, v]) => ({ key, label: labelOf(key), costUsd: v.cost, callCount: v.count, pctOfTotal: total > 0 ? (v.cost / total) * 100 : 0 }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

/** Breakdown "за видом" (ADR-035 §2) — role is a raw internal string; `labelOf` translates it to plain Ukrainian. */
export function breakdownByRole(calls: SpendCallInput[], labelOf: (role: string) => string): BreakdownItem[] {
  return groupBy(calls, (c) => c.role, labelOf);
}

/** Breakdown by provider (Anthropic/OpenAI). */
export function breakdownByProvider(calls: SpendCallInput[], labelOf: (provider: string) => string): BreakdownItem[] {
  return groupBy(calls, (c) => c.provider, labelOf);
}

export interface DailyPoint {
  day: number;
  costUsd: number;
}

/** Daily spend trend for the current month, one point per day up to `daysElapsed` (ADR-035 §4). */
export function dailyTrend(calls: SpendCallInput[], daysElapsed: number): DailyPoint[] {
  const byDay = new Map<number, number>();
  for (const c of calls) byDay.set(c.day, (byDay.get(c.day) ?? 0) + c.costUsd);
  const safeDaysElapsed = Math.max(daysElapsed, 0);
  const points: DailyPoint[] = [];
  for (let day = 1; day <= safeDaysElapsed; day++) points.push({ day, costUsd: byDay.get(day) ?? 0 });
  return points;
}

export interface ErrorFallbackSummary {
  totalCalls: number;
  errorCount: number;
  fallbackCount: number;
}

/** Error/fallback counter (ADR-035 §5) — a cheap, already-tracked signal. */
export function errorFallbackSummary(calls: SpendCallInput[]): ErrorFallbackSummary {
  let errorCount = 0;
  let fallbackCount = 0;
  for (const c of calls) {
    if (c.status === "error") errorCount++;
    if (c.fallbackUsed) fallbackCount++;
  }
  return { totalCalls: calls.length, errorCount, fallbackCount };
}
