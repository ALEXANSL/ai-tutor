import { describe, expect, it } from "vitest";
import { deriveParentModeKey, issueParentModeToken, verifyParentModeToken } from "./parent-mode-token";

const key = deriveParentModeKey("test-pepper-not-a-real-secret-0123456789");
const now = new Date("2026-09-25T10:00:00Z");
const base = { uid: "child-app-user", fam: "family-1", deviceId: "device-abc" };

describe("parent_mode cookie token (US-1.5 KP-1, KP-3)", () => {
  const { token } = issueParentModeToken({ ...base, idleMinutes: 5, now }, key);

  it("verifies on the same device, user and family before the idle deadline", () => {
    const claims = verifyParentModeToken(token, key, { ...base, now: new Date("2026-09-25T10:04:59Z") });
    expect(claims?.exp).toBe(new Date("2026-09-25T10:05:00Z").getTime());
  });

  it("expires after the idle window (auto-exit)", () => {
    expect(verifyParentModeToken(token, key, { ...base, now: new Date("2026-09-25T10:05:00Z") })).toBeNull();
  });

  it("is bound to the device", () => {
    expect(verifyParentModeToken(token, key, { ...base, deviceId: "other-device", now })).toBeNull();
    expect(verifyParentModeToken(token, key, { ...base, deviceId: undefined, now })).toBeNull();
  });

  it("is bound to the child session and family", () => {
    expect(verifyParentModeToken(token, key, { ...base, uid: "someone-else", now })).toBeNull();
    expect(verifyParentModeToken(token, key, { ...base, fam: "family-2", now })).toBeNull();
  });

  it("rejects tampered payloads and signatures", () => {
    const [payload, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), exp: Date.now() * 2 }),
    ).toString("base64url");
    expect(verifyParentModeToken(`${forged}.${sig}`, key, { ...base, now })).toBeNull();
    expect(verifyParentModeToken(`${payload}.AAAA`, key, { ...base, now })).toBeNull();
    expect(verifyParentModeToken("garbage", key, { ...base, now })).toBeNull();
    expect(verifyParentModeToken(undefined, key, { ...base, now })).toBeNull();
  });

  it("rejects tokens signed with another key (different PIN_PEPPER)", () => {
    const otherKey = deriveParentModeKey("another-pepper-value-000000000");
    expect(verifyParentModeToken(token, otherKey, { ...base, now })).toBeNull();
  });
});
