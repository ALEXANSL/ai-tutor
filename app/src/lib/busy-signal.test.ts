import { beforeEach, describe, expect, it } from "vitest";
import { isAppBusy, markBusyEnd, markBusyStart, withBusySignal } from "./busy-signal";

/**
 * BUG (2026-09-30, PO): `IdleWatcher` needs a way to know "a long-running
 * admin action is in flight" so it doesn't kick the parent to the child
 * view mid-run just because they haven't clicked anything. This is the
 * plain counter it reads.
 */
describe("busy-signal", () => {
  beforeEach(() => {
    // Drain any count left over from a previous test (defensive — each test
    // below balances its own start/end, but this keeps failures isolated).
    while (isAppBusy()) markBusyEnd();
  });

  it("starts not busy", () => {
    expect(isAppBusy()).toBe(false);
  });

  it("is busy after markBusyStart and not busy after the matching markBusyEnd", () => {
    markBusyStart();
    expect(isAppBusy()).toBe(true);
    markBusyEnd();
    expect(isAppBusy()).toBe(false);
  });

  it("stays busy while multiple overlapping operations are in flight (e.g. two panels at once)", () => {
    markBusyStart();
    markBusyStart();
    expect(isAppBusy()).toBe(true);
    markBusyEnd();
    expect(isAppBusy()).toBe(true); // one of the two is still running
    markBusyEnd();
    expect(isAppBusy()).toBe(false);
  });

  it("never goes negative on an unbalanced markBusyEnd", () => {
    markBusyEnd();
    markBusyEnd();
    expect(isAppBusy()).toBe(false);
    markBusyStart();
    expect(isAppBusy()).toBe(true);
  });

  it("withBusySignal marks busy for the duration of the async function and clears after", async () => {
    let busyDuringCall = false;
    const result = await withBusySignal(async () => {
      busyDuringCall = isAppBusy();
      return "done";
    });
    expect(busyDuringCall).toBe(true);
    expect(result).toBe("done");
    expect(isAppBusy()).toBe(false);
  });

  it("withBusySignal still clears the busy flag when the wrapped function throws", async () => {
    await expect(
      withBusySignal(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(isAppBusy()).toBe(false);
  });
});
