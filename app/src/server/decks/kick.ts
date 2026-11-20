import "server-only";
import { send } from "@vercel/queue";
import { forFamily } from "@/server/db/family-scope";
import { runJobs } from "@/server/jobs/runner";
import { WORK_TYPE } from "./store";
import { registerDeckJobs } from "./workflow";

const topic = "presentation-narration";
interface Delivery { familyId: string; id: string; jobId: string }
interface Work { id: string; status: string; run_after: string; locked_until: string | null; updated_at: string }

async function pendingWork(familyId: string, id: string) {
  const result = await forFamily(familyId).select("jobs", "id,status,run_after,locked_until,updated_at")
    .eq("type", WORK_TYPE).eq("dedupe_key", `${WORK_TYPE}:${id}`).in("status", ["queued", "running"]).maybeSingle<Work>();
  if (result.error) throw new Error("Не вдалося перевірити фонове завдання.");
  return result.data;
}
function delayFor(work: Work) {
  const date = work.status === "running" ? work.locked_until : work.run_after;
  return date ? Math.max(0, Math.ceil((Date.parse(date) - Date.now()) / 1000)) : 0;
}
async function publish(message: Delivery, key: string, delaySeconds: number) {
  await send(topic, message, { idempotencyKey: key, delaySeconds, retentionSeconds: 604800 });
}

/** Await the broker's acceptance before acknowledging the parent request. */
export async function kickDeck(familyId: string, id: string) {
  const work = await pendingWork(familyId, id);
  if (work) await publish({ familyId, id, jobId: work.id }, `start-${work.id}`, delayFor(work));
}

export class WaitForDeck extends Error {
  constructor(readonly seconds: number) { super("Waiting for the saved retry time or worker lease"); }
}

/** The broker redelivers an unacknowledged message if this invocation dies.
 * Commit the next durable delivery before acknowledging this one. */
export async function consumeDeck(message: Delivery) {
  const { familyId, id, jobId } = message;
  const work = await pendingWork(familyId, id);
  if (!work || work.id !== jobId) return;
  const delay = delayFor(work);
  if (delay > 0) throw new WaitForDeck(delay);
  registerDeckJobs();
  await runJobs({ budgetMs: 240000, maxJobs: 1, target: { familyId, type: WORK_TYPE, dedupeKey: `${WORK_TYPE}:${id}`, jobId } });
  const next = await pendingWork(familyId, id);
  if (!next || next.id !== jobId) return;
  if (next.status === "running" || work.updated_at === next.updated_at) throw new WaitForDeck(Math.max(2, delayFor(next)));
  await publish(message, `step-${jobId}-${next.updated_at}`, delayFor(next));
}
