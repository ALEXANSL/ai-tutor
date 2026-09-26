import { afterEach, describe, expect, it } from "vitest";
import { getPinPepper, pinPepperIssue } from "./env";

const ORIGINAL = process.env.PIN_PEPPER;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PIN_PEPPER;
  else process.env.PIN_PEPPER = ORIGINAL;
});

/** BUG-005: a specific, loggable reason instead of a generic failure. */
describe("pinPepperIssue / getPinPepper", () => {
  it("reports 'missing' when PIN_PEPPER is unset or blank", () => {
    delete process.env.PIN_PEPPER;
    expect(pinPepperIssue()).toBe("missing");
    expect(getPinPepper()).toBeNull();
    process.env.PIN_PEPPER = "   ";
    expect(pinPepperIssue()).toBe("missing");
    expect(getPinPepper()).toBeNull();
  });

  it("reports 'too_short' when PIN_PEPPER is under 16 characters", () => {
    process.env.PIN_PEPPER = "short-pepper";
    expect(pinPepperIssue()).toBe("too_short");
    expect(getPinPepper()).toBeNull();
  });

  it("returns the value and no issue when PIN_PEPPER is 16+ characters", () => {
    process.env.PIN_PEPPER = "a".repeat(16);
    expect(pinPepperIssue()).toBeNull();
    expect(getPinPepper()).toBe("a".repeat(16));
  });
});
