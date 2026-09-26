import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * BUG-027: `ParentModeAutoExit` (any child-screen render on a device where
 * `parentMode !== "none"`) used to call `clearParentMode`, which deletes the
 * `parent_mode` cookie outright — so the *next* request from a genuinely
 * still-active cabinet tab (e.g. a different tab/window on the same shared
 * tablet) reads `parentMode: "none"` and `requireParentAccess` sends it to
 * the harsh `/denied` screen, indistinguishable from "never entered parent
 * mode". This simulates exactly that sequence — "active -> cookie touched
 * by the auto-exit side effect from elsewhere -> next request to the
 * cabinet" — against the real cookie value and the real token verifier, and
 * checks it now lands on the friendly `/today` redirect instead.
 */

type CookieRecord = { value: string };

const store = new Map<string, CookieRecord>();

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => store.get(name),
    set: (name: string, value: string) => {
      store.set(name, { value });
    },
    delete: (name: string) => {
      store.delete(name);
    },
  }),
}));

beforeEach(() => {
  store.clear();
});

const { PARENT_MODE_COOKIE, DEVICE_COOKIE, deriveParentModeKey, issueParentModeToken, verifyParentModeToken } =
  await import("./parent-mode-token");
const { clearParentMode, expireParentModeSilently } = await import("./parent-mode");
const { parentAccessRedirectTarget } = await import("./guards");

const PEPPER = "test-pepper-not-a-real-secret-0123456789";
const key = deriveParentModeKey(PEPPER);
const claimsBase = { uid: "child-app-user", fam: "family-1", deviceId: "device-abc" };

/** Mirrors `readParentMode` in `./session.ts` (not exported) against the real cookie store. */
function readParentModeState(now: Date): "active" | "expired" | "none" {
  const token = store.get(PARENT_MODE_COOKIE)?.value;
  if (!token) return "none";
  const claims = verifyParentModeToken(token, key, { ...claimsBase, now });
  return claims ? "active" : "expired";
}

describe("BUG-027: softened parent-mode auto-exit", () => {
  it("clearParentMode (explicit exit / sign-out) leaves the state as 'none'", () => {
    const { token } = issueParentModeToken({ ...claimsBase, idleMinutes: 30, now: new Date() }, key);
    store.set(PARENT_MODE_COOKIE, { value: token });
    store.set(DEVICE_COOKIE, { value: "device-abc" });

    return clearParentMode().then(() => {
      expect(readParentModeState(new Date())).toBe("none");
      expect(parentAccessRedirectTarget("none")).toBe("/denied");
    });
  });

  it("expireParentModeSilently (child-screen auto-exit) softens 'active' to 'expired', not 'none'", async () => {
    const now = new Date("2026-09-26T10:00:00Z");
    const { token } = issueParentModeToken({ ...claimsBase, idleMinutes: 30, now }, key);
    store.set(PARENT_MODE_COOKIE, { value: token });
    store.set(DEVICE_COOKIE, { value: "device-abc" });
    expect(readParentModeState(now)).toBe("active");

    // Another tab's child screen renders and fires the auto-exit side effect.
    await expireParentModeSilently();

    expect(readParentModeState(now)).toBe("expired");
    // ... which sends a still-active cabinet tab's next request to "/today",
    // not the harsh "/denied" it used to get.
    expect(parentAccessRedirectTarget("expired")).toBe("/today");
  });

  it("is a no-op when there is nothing active to soften", async () => {
    await expireParentModeSilently();
    expect(store.has(PARENT_MODE_COOKIE)).toBe(false);
    expect(readParentModeState(new Date())).toBe("none");
  });
});
