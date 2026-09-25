import { describe, expect, it } from "vitest";
import { isCronAuthorized } from "./cron-auth";
import { backoffSeconds } from "./runner";

describe("cron endpoint auth", () => {
  it("accepts only the exact bearer secret", () => {
    expect(isCronAuthorized("Bearer s3cret-placeholder", "s3cret-placeholder")).toBe(true);
    expect(isCronAuthorized("Bearer wrong", "s3cret-placeholder")).toBe(false);
    expect(isCronAuthorized("s3cret-placeholder", "s3cret-placeholder")).toBe(false);
    expect(isCronAuthorized(null, "s3cret-placeholder")).toBe(false);
    expect(isCronAuthorized("Bearer ", null)).toBe(false);
  });
});

describe("job retry backoff (ADR-015)", () => {
  it("grows exponentially and is capped", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(30)).toBe(1800);
  });
});
