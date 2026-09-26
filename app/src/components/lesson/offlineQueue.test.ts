import { describe, expect, it, vi } from "vitest";
import { resendQueued, submitAnswerOffline, type QueuedAnswer } from "./offlineQueue";

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

/**
 * BUG-012: `LessonRunner.submit()` must queue the answer BEFORE the network
 * call (not only in a `catch` after it), and only dequeue it after a
 * confirmed success — so a request that hangs and a tab closed mid-flight
 * never loses the answer, unlike the original ("network → catch → queue")
 * order.
 */
describe("submitAnswerOffline (BUG-012: enqueue before the network call, dequeue only after success)", () => {
  it("enqueues before calling `send`, and dequeues only after `send` resolves", async () => {
    const order: string[] = [];
    const enqueue = vi.fn(async () => {
      order.push("enqueue");
    });
    const dequeue = vi.fn(async () => {
      order.push("dequeue");
    });
    const send = vi.fn(async () => {
      order.push("send");
    });
    const entry = answer();

    const result = await submitAnswerOffline(entry, send, { enqueue, dequeue });

    expect(order).toEqual(["enqueue", "send", "dequeue"]);
    expect(enqueue).toHaveBeenCalledWith(entry);
    expect(dequeue).toHaveBeenCalledWith(entry.idempotencyKey);
    expect(result).toEqual({ ok: true });
  });

  it("keeps the entry queued (never dequeues) when the network call fails — even if it fails after being in flight for a while", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const dequeue = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn().mockRejectedValue(new Error("network"));
    const entry = answer();

    const result = await submitAnswerOffline(entry, send, { enqueue, dequeue });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(dequeue).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false });
  });

  it("has already enqueued the answer even if `send` never settles (simulates a hung request the tab could close during)", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const dequeue = vi.fn().mockResolvedValue(undefined);
    let resolveSend: () => void = () => {};
    const send = vi.fn(() => new Promise<void>((resolve) => (resolveSend = resolve)));
    const entry = answer();

    const pending = submitAnswerOffline(entry, send, { enqueue, dequeue });
    await Promise.resolve(); // let the microtask queue advance past `await deps.enqueue(entry)`

    expect(enqueue).toHaveBeenCalledWith(entry); // already safe on the device before `send` settles
    expect(dequeue).not.toHaveBeenCalled();

    resolveSend();
    await pending;
    expect(dequeue).toHaveBeenCalledWith(entry.idempotencyKey);
  });
});
