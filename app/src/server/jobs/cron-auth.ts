import { timingSafeEqual } from "node:crypto";

/** Constant-time check of `Authorization: Bearer <CRON_SECRET>` (ADR-015, docs/02 11). */
export function isCronAuthorized(header: string | null, secret: string | null): boolean {
  if (!secret || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
