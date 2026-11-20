"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireParentAccess } from "@/server/auth/guards";
import { confirmUpload } from "@/server/drive/upload";
import { documentId } from "@/server/audiobooks/store";
import { enqueueJob } from "@/server/jobs/runner";
import { kickDeck } from "@/server/decks/kick";
import { forFamily } from "@/server/db/family-scope";
import { DECK_TYPE, WORK_TYPE, getDeck, updateDeck } from "@/server/decks/store";
import type { NarratedDeck } from "@/lib/narrated-deck";

async function schedule(family: string, id: string) {
  await enqueueJob(family, WORK_TYPE, { deckId: id }, { dedupeKey: `${WORK_TYPE}:${id}`, maxAttempts: 2 });
  kickDeck(family, id);
}

export async function startDeck(driveId: string, subjectId: string) {
  const { familyId } = await requireParentAccess();
  z.string().uuid().parse(subjectId);
  const scope = forFamily(familyId);
  const subject = await scope.select("subjects", "id").eq("id", subjectId).maybeSingle();
  if (!subject.data) throw new Error("Предмет не знайдено.");
  const file = await confirmUpload({ familyId, driveFileId: driveId });
  if (file.format !== "pptx") throw new Error("Для показу слайдів потрібен файл PPTX.");
  const id = documentId(JSON.stringify(["narrated-deck", familyId, subjectId, file.md5Checksum || file.id]));
  const deck: NarratedDeck = { title: file.name.replace(/\.pptx$/i, ""), driveId, subjectId, revision: 0, error: "", slides: [], state: "processing", published: false };
  const result = await scope.insert("jobs", { id, type: DECK_TYPE, status: "done", payload: deck });
  if (result.error && result.error.code !== "23505") throw new Error("Не вдалося зберегти презентацію.");
  if (!result.error || (await getDeck(familyId, id))?.state === "processing") await schedule(familyId, id);
  return id;
}

export async function retryDeck(id: string) {
  const { familyId } = await requireParentAccess();
  const deck = await getDeck(familyId, id);
  if (!deck || deck.state === "ready") return;
  if (deck.state === "error") await updateDeck(familyId, id, deck, { state: "processing", error: "" });
  await schedule(familyId, id);
  revalidatePath(`/parent/studio/presentations/${id}`);
}

export async function publishDeck(id: string, published: boolean) {
  const { familyId } = await requireParentAccess();
  z.boolean().parse(published);
  const deck = await getDeck(familyId, id);
  if (!deck || deck.state !== "ready" || !deck.slides.length || !deck.slides.every(s => s.ready && s.narration)) throw new Error("Публікація доступна після озвучення всіх слайдів.");
  await updateDeck(familyId, id, deck, { published });
  revalidatePath(`/parent/studio/presentations/${id}`);
  revalidatePath(`/subject/${deck.subjectId}`);
}
