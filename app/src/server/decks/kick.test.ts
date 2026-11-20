import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ read: vi.fn(), send: vi.fn(), run: vi.fn() }));
vi.mock("@vercel/queue", () => ({ send: f.send }));
vi.mock("@/server/jobs/runner", () => ({ runJobs: f.run }));
vi.mock("./workflow", () => ({ registerDeckJobs: vi.fn() }));
vi.mock("./store", () => ({ WORK_TYPE: "presentation.prepare" }));
vi.mock("@/server/db/family-scope", () => ({ forFamily: () => {
  const chain = { eq: () => chain, in: () => chain, maybeSingle: f.read };
  return { select: () => chain };
} }));
import { kickDeck, consumeDeck, WaitForDeck } from "./kick";

const msg = { familyId: "family", id: "presentation", jobId: "job" };
const initial = { id: msg.jobId, status: "queued", updated_at: "initial", run_after: new Date(0).toISOString(), locked_until: null };
beforeEach(() => vi.resetAllMocks());

it("drains all remaining checkpoints from slide seven with only broker deliveries after the single start", async () => {
  let pending: typeof initial | null = { ...initial }, scripts = 7, recordings = 6;
  const deliveries: typeof msg[] = [];
  f.read.mockImplementation(async () => ({ data: pending }));
  f.send.mockImplementation(async (_topic, message) => { deliveries.push(message); });
  f.run.mockImplementation(async () => {
    if (scripts === recordings) scripts++; else recordings++;
    pending = recordings === 14 ? null : { ...initial, updated_at: String(scripts + recordings) };
  });
  await kickDeck(msg.familyId, msg.id);
  while (deliveries.length) await consumeDeck(deliveries.shift()!);
  expect([scripts, recordings]).toEqual([14, 14]);
  expect(f.run).toHaveBeenCalledTimes(15);
  expect(f.run.mock.calls.every(([input]) => input.maxJobs === 1 && input.target.jobId === msg.jobId)).toBe(true);
  await consumeDeck(msg);
  expect(f.run).toHaveBeenCalledTimes(15);
});

it("leaves an interrupted worker's message available for redelivery after its lease", async () => {
  f.read.mockResolvedValue({ data: { ...initial, status: "running", locked_until: new Date(Date.now() + 60000).toISOString() } });
  await expect(consumeDeck(msg)).rejects.toBeInstanceOf(WaitForDeck);
  expect(f.run).not.toHaveBeenCalled();
});

it("does not acknowledge a step when publication of its successor fails", async () => {
  f.read.mockResolvedValueOnce({ data: initial }).mockResolvedValueOnce({ data: { ...initial, updated_at: "next" } });
  f.send.mockRejectedValueOnce(new Error("broker unavailable"));
  await expect(consumeDeck(msg)).rejects.toThrow("broker unavailable");
});

it("recovers an overdue checkpoint even if the broker remembers a previous wake", async () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(initial.run_after));
    f.read.mockResolvedValue({ data: initial });
    await kickDeck(msg.familyId, msg.id);
    await kickDeck(msg.familyId, msg.id);
    vi.advanceTimersByTime(300001);
    await kickDeck(msg.familyId, msg.id);
    const keys = f.send.mock.calls.map(call => call[2].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  } finally { vi.useRealTimers(); }
});
