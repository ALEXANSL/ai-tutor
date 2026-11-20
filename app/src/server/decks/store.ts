import "server-only";
import { z } from "zod";
import { forFamily } from "@/server/db/family-scope";
import type { NarratedDeck } from "@/lib/narrated-deck";

export const DECK_TYPE = "presentation.deck";
export const WORK_TYPE = "presentation.prepare";
export const pdfPath = (family: string, id: string) => `${family}/presentations/${id}/slides.pdf`;

export async function getDeck(family: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) return undefined;
  const { data, error } = await forFamily(family).select("jobs", "payload").eq("id", id).eq("type", DECK_TYPE).maybeSingle<{ payload: NarratedDeck }>();
  if (error) throw new Error("Не вдалося отримати презентацію.");
  return data?.payload;
}

export async function updateDeck(family: string, id: string, deck: NarratedDeck, patch: Partial<NarratedDeck>) {
  const next = { ...deck, ...patch, revision: deck.revision + 1 };
  const result = await forFamily(family).update("jobs", { payload: next }).eq("type", DECK_TYPE).eq("id", id)
    .eq("payload->>revision", String(deck.revision)).select("id").single();
  if (result.error) throw new Error("Презентацію вже оновлено. Онови сторінку.");
  return next;
}

export async function listDecks(family: string, publishedSubject?: string, topicId?: string) {
  let query = forFamily(family).select("jobs", "id,topicId:payload->>topicId,title:payload->>title,state:payload->>state,published:payload->>published").eq("type", DECK_TYPE);
  if (publishedSubject) query = query.eq("payload->>published", "true").eq("payload->>state", "ready").eq("payload->>subjectId", publishedSubject);
  if (topicId) query = query.eq("payload->>topicId", topicId);
  const { data, error } = await query.order("created_at", { ascending: false }).returns<{ id: string; topicId: string | null; title: string; state: string; published: string }[]>();
  if (error) throw new Error("Не вдалося отримати список презентацій.");
  return data;
}
