"use client";

/**
 * BUG (2026-09-30, PO): `IdleWatcher` only resets its idle timer on a real
 * `pointerdown`/`keydown`/`scroll`/`touchstart` DOM event — a parent who
 * starts a known-long admin action (content_qa sweep, literature
 * extraction, bulk warmup confirm) and then just watches the screen
 * without touching anything gets silently kicked to the child view mid-run
 * ("система викидає на дитячу сторінку... потрібно сидіти і клацати
 * мишкою"). Waiting on a pending fetch/server action was never activity by
 * that definition.
 *
 * This is a tiny module-level counter (no React context needed — every
 * consumer is a client component that already imports plain functions from
 * here) any long-running panel increments while its own operation is in
 * flight and decrements when it settles. `IdleWatcher` checks
 * `isAppBusy()` on every tick and treats "busy" exactly like fresh
 * activity, so the idle countdown simply pauses for as long as a
 * registered operation is running — it never needs to know which panel,
 * or how many, are busy at once.
 */
let activeCount = 0;

export function markBusyStart(): void {
  activeCount += 1;
}

export function markBusyEnd(): void {
  activeCount = Math.max(0, activeCount - 1);
}

export function isAppBusy(): boolean {
  return activeCount > 0;
}

/** Wraps an async operation so callers never forget the matching `markBusyEnd()` (e.g. on a thrown error). */
export async function withBusySignal<T>(fn: () => Promise<T>): Promise<T> {
  markBusyStart();
  try {
    return await fn();
  } finally {
    markBusyEnd();
  }
}
