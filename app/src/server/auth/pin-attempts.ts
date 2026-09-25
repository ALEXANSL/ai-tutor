/**
 * Parent-mode PIN attempt policy (US-1.5 KP-2): after N wrong PINs in a row
 * input is locked for M minutes and the parent gets an event. Pure logic.
 */
export interface PinAttemptState {
  failed: number;
  lockedUntil: Date | null;
}

export interface PinPolicy {
  maxAttempts: number;
  lockMinutes: number;
}

export type PinAttemptOutcome = "ok" | "wrong" | "locked_now";

export function isPinLocked(state: PinAttemptState, now: Date): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
}

export function applyPinAttempt(
  state: PinAttemptState,
  success: boolean,
  now: Date,
  policy: PinPolicy,
): { state: PinAttemptState; outcome: PinAttemptOutcome; attemptsLeft: number } {
  if (success) {
    return { state: { failed: 0, lockedUntil: null }, outcome: "ok", attemptsLeft: policy.maxAttempts };
  }
  const failed = state.failed + 1;
  if (failed >= policy.maxAttempts) {
    return {
      state: { failed: 0, lockedUntil: new Date(now.getTime() + policy.lockMinutes * 60_000) },
      outcome: "locked_now",
      attemptsLeft: 0,
    };
  }
  return { state: { failed, lockedUntil: null }, outcome: "wrong", attemptsLeft: policy.maxAttempts - failed };
}
