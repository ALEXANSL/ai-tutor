import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { isValidPinFormat } from "@/lib/pin-format";
import { getPinPepper } from "../env";
import { forFamily } from "../db/family-scope";
import { loadParentSettings } from "../persona/service";
import { notifyParent } from "../notifications";
import { applyPinAttempt, isPinLocked } from "./pin-attempts";
import { hashPin, verifyPin } from "./pin-hash";
import { DEVICE_COOKIE, PARENT_MODE_COOKIE, deriveParentModeKey, issueParentModeToken } from "./parent-mode-token";
import type { UserContext } from "./session";

export type EnterParentModeError = "format" | "wrong" | "locked" | "not_set" | "unavailable";
export type EnterParentModeResult = { ok: true } | { ok: false; error: EnterParentModeError };

const secureCookies = () => process.env.NODE_ENV === "production";

async function setParentModeCookie(ctx: UserContext, idleMinutes: number, pepper: string): Promise<void> {
  const store = await cookies();
  let deviceId = store.get(DEVICE_COOKIE)?.value;
  if (!deviceId) {
    deviceId = randomBytes(24).toString("base64url");
    store.set(DEVICE_COOKIE, deviceId, {
      httpOnly: true,
      secure: secureCookies(),
      sameSite: "lax",
      path: "/",
      maxAge: 400 * 24 * 60 * 60,
    });
  }
  const { token } = issueParentModeToken(
    { uid: ctx.appUserId, fam: ctx.familyId, deviceId, idleMinutes, now: new Date() },
    deriveParentModeKey(pepper),
  );
  store.set(PARENT_MODE_COOKIE, token, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "strict",
    path: "/",
    maxAge: idleMinutes * 60,
  });
}

/**
 * US-1.5 KP-1, KP-2: PIN check on the child's tablet. The PIN is never
 * logged. After N wrong attempts input is locked and the parent gets an event.
 */
export async function enterParentMode(ctx: UserContext, pin: string): Promise<EnterParentModeResult> {
  if (ctx.role !== "child") return { ok: false, error: "unavailable" };
  const pepper = getPinPepper();
  if (!pepper) return { ok: false, error: "unavailable" };
  if (!isValidPinFormat(pin)) return { ok: false, error: "format" };

  const scope = forFamily(ctx.familyId);
  const settings = await loadParentSettings(scope);
  if (!settings.pin_hash) return { ok: false, error: "not_set" };

  const now = new Date();
  const state = {
    failed: settings.pin_failed,
    lockedUntil: settings.pin_locked_until ? new Date(settings.pin_locked_until) : null,
  };
  if (isPinLocked(state, now)) return { ok: false, error: "locked" };

  const ok = await verifyPin(settings.pin_hash, pin, pepper);
  const result = applyPinAttempt(state, ok, now, {
    maxAttempts: settings.pin_max_attempts,
    lockMinutes: settings.pin_lock_minutes,
  });
  const { error } = await scope.update("parent_settings", {
    pin_failed: result.state.failed,
    pin_locked_until: result.state.lockedUntil?.toISOString() ?? null,
  });
  if (error) throw new Error(`parent_settings update failed: ${error.message}`);

  if (result.outcome === "locked_now") {
    await notifyParent(scope, {
      type: "pin_lockout",
      severity: "normal",
      payload: { lockMinutes: settings.pin_lock_minutes },
    });
    return { ok: false, error: "locked" };
  }
  if (result.outcome === "wrong") return { ok: false, error: "wrong" };

  await setParentModeCookie(ctx, settings.parent_mode_idle_min, pepper);
  return { ok: true };
}

/** Extends the idle deadline while the parent is active (US-1.5 KP-3). */
export async function touchParentMode(ctx: UserContext): Promise<boolean> {
  const pepper = getPinPepper();
  if (ctx.role !== "child" || ctx.parentMode !== "active" || !pepper) return false;
  const settings = await loadParentSettings(forFamily(ctx.familyId));
  await setParentModeCookie(ctx, settings.parent_mode_idle_min, pepper);
  return true;
}

export async function clearParentMode(): Promise<void> {
  (await cookies()).delete(PARENT_MODE_COOKIE);
}

export type SetPinError = "format" | "mismatch" | "unavailable";

/** US-1.5 KP-5: only the parent's own account sets/changes the PIN. */
export async function setParentPin(
  familyId: string,
  pin: string,
  repeat: string,
): Promise<{ ok: true } | { ok: false; error: SetPinError }> {
  const pepper = getPinPepper();
  if (!pepper) return { ok: false, error: "unavailable" };
  if (!isValidPinFormat(pin)) return { ok: false, error: "format" };
  if (pin !== repeat) return { ok: false, error: "mismatch" };
  const pinHash = await hashPin(pin, pepper);
  const { error } = await forFamily(familyId).update("parent_settings", {
    pin_hash: pinHash,
    pin_updated_at: new Date().toISOString(),
    pin_failed: 0,
    pin_locked_until: null,
  });
  if (error) throw new Error(`PIN update failed: ${error.message}`);
  return { ok: true };
}
