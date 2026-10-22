/**
 * UI/UX research 2026-10-22 (`docs/09-ui-ux-teen-research.md`): the "Сьогодні"
 * greeting was a static "Привіт, {nickname}!" regardless of time of day.
 * Same Intl-based timezone pattern as `familyDateParts`
 * (`app/src/server/budget/time.ts`) — never hard-code a zone (ADR-018 K-4),
 * always the family's own `timeZone` from `getFamilyTimezone`.
 */

export type DayPart = "morning" | "day" | "evening" | "night";

/** The local hour (0-23) for `date` in `timeZone`. */
export function hourInTimeZone(date: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(date);
  return Number(formatted);
}

export function dayPartForHour(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "day";
  if (hour >= 18 && hour < 23) return "evening";
  return "night";
}
