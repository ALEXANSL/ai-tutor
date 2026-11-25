import "server-only";
import { documentId } from "@/server/audiobooks/store";
import { forFamily } from "@/server/db/family-scope";
import { enqueueJob } from "@/server/jobs/runner";
import { kickDeck } from "./kick";
import { DECK_TYPE, WORK_TYPE, getDeck } from "./store";
import type { NarratedDeck } from "@/lib/narrated-deck";

export async function scheduleDeck(family: string, id: string) {
  await enqueueJob(family, WORK_TYPE, { deckId: id }, { dedupeKey: `${WORK_TYPE}:${id}`, maxAttempts: 2 });
  await kickDeck(family, id);
}

export interface LessonDeckRequest { key: unknown[]; subjectId: string; topicId: string; title: string; href: string; wishes: string; sourceHash?: string }

/** Queue a narrated presentation generated from an existing lesson. The id is
 * derived from `key`, so repeating the same request never pays twice. */
export async function queueLessonDeck(family: string, request: LessonDeckRequest) {
  const id = documentId(JSON.stringify(request.key));
  const deck: NarratedDeck = { title: request.title, topicId: request.topicId, subjectId: request.subjectId, driveId: "", generated: { href: request.href, wishes: request.wishes.trim(), ...(request.sourceHash ? { sourceHash: request.sourceHash } : {}) }, state: "processing", revision: 0, slides: [], published: false, error: "" };
  const result = await forFamily(family).insert("jobs", { id, type: DECK_TYPE, status: "done", payload: deck });
  if (result.error && result.error.code !== "23505") throw new Error("Не вдалося зберегти презентацію.");
  if (!result.error || (await getDeck(family, id))?.state === "processing") await scheduleDeck(family, id);
  return id;
}

/** D-134: the lesson-deck key for a lesson published by a Studio project. */
export const studioDeckKey = (family: string, projectId: string, index: number, version?: string) =>
  ["studio-deck", family, projectId, index, ...(version ? [version] : [])];
export const studioDeckId = (family: string, projectId: string, index: number, version?: string) =>
  documentId(JSON.stringify(studioDeckKey(family, projectId, index, version)));
