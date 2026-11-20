import "server-only";
import type { NarratedDeck } from "@/lib/narrated-deck";
import { forFamily } from "@/server/db/family-scope";
import { enqueueJob } from "@/server/jobs/runner";
import { kickDeck } from "./kick";
import { WORK_TYPE, updateDeck } from "./store";
import { legacyDeckRetry } from "./retry";
interface WorkState {
  status: string;
  run_after: string;
  locked_until: string | null;
  last_error: string | null;
}
/** Used by the scheduler and for immediate adoption of legacy decks on first visit. */
export async function reconcileDeck(family: string, id: string, deck: NarratedDeck) {
  if (deck.state === "ready") return deck;
  const key = `${WORK_TYPE}:${id}`;
  if (deck.state === "error") {
    if (!legacyDeckRetry(deck.error) || deck.retryPolicyVersion === 1) return deck;
    deck = await updateDeck(family, id, deck, { state: "processing", error: "", retryPolicyVersion: 1 });
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
  }
  await kickDeck(family, id);
  return deck;
}
