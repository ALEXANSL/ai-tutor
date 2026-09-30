/**
 * Small timezone helpers for the budget dashboard (ADR-035). The family's
 * month/day always follow its own timezone (same rule as
 * `app_private.current_month` in SQL, ADR-012), never the server's UTC day.
 */

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** "Today" (or any instant) broken into the family's local calendar date. */
export function familyDateParts(date: Date, timeZone: string): DateParts {
  // en-CA gives a stable YYYY-MM-DD order regardless of runtime locale data.
  const formatted = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const [year, month, day] = formatted.split("-").map(Number) as [number, number, number];
  return { year, month, day };
}

/** Matches `spend_months.month` ("YYYY-MM"). */
export function monthKey({ year, month }: Pick<DateParts, "year" | "month">): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function daysInMonth({ year, month }: Pick<DateParts, "year" | "month">): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
