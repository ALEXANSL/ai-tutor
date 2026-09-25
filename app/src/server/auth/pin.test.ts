import { describe, expect, it } from "vitest";
import { hashPin, verifyPin } from "./pin-hash";
import { applyPinAttempt, isPinLocked, type PinAttemptState } from "./pin-attempts";
import { isValidPinFormat } from "@/lib/pin-format";

const PEPPER = "test-pepper-not-a-real-secret-0123456789";

describe("isValidPinFormat (US-1.5 KP-5)", () => {
  it.each(["1234", "12345", "123456"])("accepts %s", (pin) => expect(isValidPinFormat(pin)).toBe(true));
  it.each(["123", "1234567", "12a4", " 1234", "", null, 1234])("rejects %j", (pin) =>
    expect(isValidPinFormat(pin)).toBe(false),
  );
});

describe("hashPin / verifyPin (NFR-PRIV-9)", () => {
  it("produces a salted argon2id hash that does not contain the PIN", async () => {
    const h1 = await hashPin("4821", PEPPER);
    const h2 = await hashPin("4821", PEPPER);
    expect(h1.startsWith("$argon2id$")).toBe(true);
    expect(h1).not.toContain("4821");
    expect(h1).not.toEqual(h2); // random salt
  });

  it("verifies the right PIN and rejects a wrong one", async () => {
    const h = await hashPin("4821", PEPPER);
    expect(await verifyPin(h, "4821", PEPPER)).toBe(true);
    expect(await verifyPin(h, "4822", PEPPER)).toBe(false);
  });

  it("depends on the pepper: a leaked hash is useless without PIN_PEPPER", async () => {
    const h = await hashPin("4821", PEPPER);
    expect(await verifyPin(h, "4821", "another-pepper-value-000000000")).toBe(false);
  });

  it("refuses to hash without a strong pepper or with a bad PIN", async () => {
    await expect(hashPin("4821", "")).rejects.toThrow();
    await expect(hashPin("4821", "short")).rejects.toThrow();
    await expect(hashPin("12", PEPPER)).rejects.toThrow();
  });

  it("returns false (never throws) for garbage hashes", async () => {
    expect(await verifyPin("not-a-hash", "4821", PEPPER)).toBe(false);
    expect(await verifyPin("", "4821", PEPPER)).toBe(false);
  });
});

describe("PIN attempts policy (US-1.5 KP-2)", () => {
  const policy = { maxAttempts: 5, lockMinutes: 15 };
  const now = new Date("2026-09-25T10:00:00Z");

  it("locks for 15 minutes after 5 wrong PINs in a row", () => {
    let state: PinAttemptState = { failed: 0, lockedUntil: null };
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = applyPinAttempt(state, false, now, policy);
      outcomes.push(r.outcome);
      state = r.state;
    }
    expect(outcomes).toEqual(["wrong", "wrong", "wrong", "wrong", "locked_now"]);
    expect(state.lockedUntil?.toISOString()).toBe("2026-09-25T10:15:00.000Z");
    expect(isPinLocked(state, new Date("2026-09-25T10:14:59Z"))).toBe(true); // 6th attempt is blocked
    expect(isPinLocked(state, new Date("2026-09-25T10:15:00Z"))).toBe(false);
  });

  it("reports attempts left and resets the counter after a correct PIN", () => {
    const r1 = applyPinAttempt({ failed: 3, lockedUntil: null }, false, now, policy);
    expect(r1.attemptsLeft).toBe(1);
    const r2 = applyPinAttempt(r1.state, true, now, policy);
    expect(r2).toEqual({ state: { failed: 0, lockedUntil: null }, outcome: "ok", attemptsLeft: 5 });
  });

  it("honours a configured policy", () => {
    const r = applyPinAttempt({ failed: 2, lockedUntil: null }, false, now, { maxAttempts: 3, lockMinutes: 1 });
    expect(r.outcome).toBe("locked_now");
    expect(r.state.lockedUntil?.toISOString()).toBe("2026-09-25T10:01:00.000Z");
  });
});
