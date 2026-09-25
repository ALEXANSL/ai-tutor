import { describe, expect, it, vi } from "vitest";
import { resendQueued, type QueuedAnswer } from "./offlineQueue";

/**
 * BUG-007: an answer given during a network drop is queued on the device
 * and resent automatically once the connection returns, using the same
 * `idempotencyKey` the server de-duplicates on (US-6.5 КП-2, NFR-RES-1).
 */
function answer(over: Partial<QueuedAnswer> = {}): QueuedAnswer {
  return {
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    sessionId: "s1",
    stepId: "step1",
    channel: "choice",
    answer: { optionId: "a" },
    latencyMs: 1200,
    queuedAt: 1,
    ...over,
  };
}

describe("resendQueued (offline answer buffer)", () => {
  it("sends a queued answer with the same idempotencyKey once the network is back", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const entry = answer();
    const { sent, failedAt } = await resendQueued([entry], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(entry);
    expect(sent).toEqual([entry]);
    expect(failedAt).toBeNull();
  });

  it("retries a failed send later without duplicating: first attempt throws, second succeeds with the same key", async () => {
    const entry = answer();
    const failingSend = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(undefined);

    const first = await resendQueued([entry], failingSend);
    expect(first.failedAt).toBe(0);
    expect(first.sent).toEqual([]);

    // Simulates "online" firing again: same entry, still in the queue, sent again.
    const second = await resendQueued([entry], failingSend);
    expect(second.failedAt).toBeNull();
    expect(second.sent).toEqual([entry]);

    expect(failingSend).toHaveBeenCalledTimes(2);
    expect(failingSend.mock.calls[0]![0]).toBe(entry);
    expect(failingSend.mock.calls[1]![0]).toBe(entry);
    expect(failingSend.mock.calls[0]![0].idempotencyKey).toBe(failingSend.mock.calls[1]![0].idempotencyKey);
  });

  it("sends multiple queued answers oldest-first and stops at the first failure (no reordering)", async () => {
    const a = answer({ idempotencyKey: "a", queuedAt: 1 });
    const b = answer({ idempotencyKey: "b", queuedAt: 2 });
    const c = answer({ idempotencyKey: "c", queuedAt: 3 });
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(undefined);

    const { sent, failedAt } = await resendQueued([a, b, c], send);
    expect(sent).toEqual([a]);
    expect(failedAt).toBe(1);
    expect(send).toHaveBeenCalledTimes(2); // never reaches `c` while `b` is still failing
  });
});
