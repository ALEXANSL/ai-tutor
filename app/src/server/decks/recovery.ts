import "server-only";
import type { NarratedDeck } from "@/lib/narrated-deck";
import { forFamily } from "@/server/db/family-scope";
import { enqueueJob } from "@/server/jobs/runner";
import { kickDeck } from "./kick";
import { WORK_TYPE, updateDeck } from "./store";

const audioLookupError = "Не вдалося перевірити збережений аудіофрагмент.";
interface WorkState {
  status: string;
  run_after: string;
  locked_until: string | null;
  last_error: string | null;
}
export function needsWake(job: WorkState, now: number) {
  return job.status === "queued" ? Date.parse(job.run_after) <= now
    : job.status === "running" && (!job.locked_until || Date.parse(job.locked_until) <= now);
}

/** A page refresh reconciles the durable work item, including old presentations.
 * Only automatically reopen legacy failures known to precede synthesis. */
export async function reconcileDeck(family: string, id: string, deck: NarratedDeck) {
  if (deck.state === "ready") return deck;
  const key = `${WORK_TYPE}:${id}`;
  if (deck.state === "error") {
    if (deck.error !== audioLookupError || deck.audioLookupRecovered) return deck;
    deck = await updateDeck(family, id, deck, { state: "processing", error: "", audioLookupRecovered: true });
    await enqueueJob(family, WORK_TYPE, { deckId: id }, { dedupeKey: key, maxAttempts: 2 });
  }
  const { data: job, error } = await forFamily(family).select("jobs", "status,run_after,locked_until,last_error")
    .eq("type", WORK_TYPE).eq("dedupe_key", key).order("created_at", { ascending: false }).limit(1).maybeSingle<WorkState>();
  if (error) throw new Error("Не вдалося прочитати стан черги озвучення.");
  if (job?.status === "failed" && job.last_error !== "no handler") {
    return updateDeck(family, id, deck, { state: "error", error: job.last_error || "Не вдалося завершити підготовку слайда." });
  }
  if (!job || job.status === "done" || job.status === "failed") {
    await enqueueJob(family, WORK_TYPE, { deckId: id }, { dedupeKey: key, maxAttempts: 2 });
    kickDeck(family, id);
  } else if (needsWake(job, Date.now())) kickDeck(family, id);
  return deck;
}
