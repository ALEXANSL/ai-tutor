"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { requireParentAccess } from "@/server/auth/guards";
import { confirmUpload } from "@/server/drive/upload";
import { documentId } from "@/server/audiobooks/store";
import { queueLessonDeck, scheduleDeck } from "@/server/decks/lesson-deck";
import { forFamily } from "@/server/db/family-scope";
import { deckLessonOptions } from "@/server/decks/placement";
import { DECK_TYPE, getDeck, updateDeck } from "@/server/decks/store";
import type { NarratedDeck } from "@/lib/narrated-deck";

const schedule = scheduleDeck;

export async function deckLessonsAction(subjectId: string) {
  const { familyId } = await requireParentAccess();
  return deckLessonOptions(familyId, z.string().uuid().parse(subjectId));
}

async function validatePlacement(familyId: string, subjectId: string, topicId: string | null) {
  if (topicId === null) return;
  z.string().uuid().parse(topicId);
  const options = await deckLessonOptions(familyId, subjectId);
  if (!options.some(item => item.id === topicId)) throw new Error("Вибраний урок недоступний у цьому предметі.");
}

export async function changeDeckPlacement(id: string, form: FormData) {
  const { familyId } = await requireParentAccess();
  const deck = await getDeck(familyId, id);
  if (!deck || deck.state === "processing") throw new Error("Зміна прив’язки доступна після підготовки.");
  const raw = z.string().parse(form.get("topicId"));
  const topicId = raw || null;
  await validatePlacement(familyId, deck.subjectId, topicId);
  await updateDeck(familyId, id, deck, { topicId });
  revalidatePath(`/subject/${deck.subjectId}`);
  revalidatePath(`/parent/studio/presentations/${id}`);
}

export async function startDeck(driveId: string, subjectId: string, topicId: string | null = null) {
  const { familyId } = await requireParentAccess();
  z.string().uuid().parse(subjectId);
  const scope = forFamily(familyId);
  const subject = await scope.select("subjects", "id").eq("id", subjectId).maybeSingle();
  if (!subject.data) throw new Error("Предмет не знайдено.");
  await validatePlacement(familyId, subjectId, topicId);
  const file = await confirmUpload({ familyId, driveFileId: driveId });
  if (file.format !== "pptx") throw new Error("Для показу слайдів потрібен файл PPTX.");
  const id = documentId(JSON.stringify(["narrated-deck", familyId, subjectId, file.md5Checksum || file.id]));
  const deck: NarratedDeck = { title: file.name.replace(/\.pptx$/i, ""), driveId, subjectId, topicId, revision: 0, error: "", slides: [], state: "processing", published: false };
  const result = await scope.insert("jobs", { id, type: DECK_TYPE, status: "done", payload: deck });
  if (result.error && result.error.code !== "23505") throw new Error("Не вдалося зберегти презентацію.");
  if (!result.error) await schedule(familyId, id);
  else {
    const existing = await getDeck(familyId, id);
    if (!existing) throw new Error("Не вдалося відкрити збережену презентацію.");
    if ((existing.topicId ?? null) !== topicId) {
      if (existing.state === "processing") throw new Error("Ця презентація вже готується. Після завершення можна змінити урок у розділі «Мої презентації».");
      await updateDeck(familyId, id, existing, { topicId });
      revalidatePath(`/subject/${subjectId}`);
    }
    if (existing.state === "processing") await schedule(familyId, id);
  }
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

/** ADR-049: render (or re-render) the server MP4 in the background. */
export async function remakeDeckVideo(id: string) {
  const { familyId } = await requireParentAccess();
  const deck = await getDeck(familyId, id);
  if (!deck || deck.state !== "ready") throw new Error("Відео можна зробити після озвучення всіх слайдів.");
  if (deck.video?.state !== "pending") await updateDeck(familyId, id, deck, { video: { state: "pending" } });
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

export async function generateLessonDeck(subjectId: string, topicId: string, wishes: string, requestId: string) {
  const { familyId } = await requireParentAccess();
  const ids = z.string().uuid();
  const options = await deckLessonOptions(familyId, ids.parse(subjectId));
  const topic = ids.parse(topicId);
  const lesson = options.find(item => item.id === topic);
  if (!lesson) throw new Error("Вибраний урок недоступний у цьому предметі.");
  return queueLessonDeck(familyId, { key: ["lesson-deck", familyId, subjectId, topic, ids.parse(requestId)], subjectId, topicId: topic, title: lesson.title, href: lesson.href, wishes: z.string().max(2000).parse(wishes) });
}

/** ADR-050: rebuild a generated deck with a real picture on every slide. Keeps the
 * script and the narration text, so saved voice files are reused and only the
 * pictures are paid for (cached pictures are free). */
export async function redrawDeckIllustrations(id: string) {
  const { familyId } = await requireParentAccess();
  z.string().uuid().parse(id);
  const deck = await getDeck(familyId, id);
  const plan = deck?.generated?.plan;
  if (!deck || !deck.generated || !plan || deck.state === "processing") throw new Error("Перемалювати можна лише готову презентацію, створену з уроку.");
  await updateDeck(familyId, id, deck, {
    state: "processing", error: "", retry: null, slides: [], video: null,
    generated: { ...deck.generated, pptxReady: false, plan: { slides: plan.slides.map(({ visual: _visual, drawing: _drawing, ...slide }) => slide) } },
  });
  await schedule(familyId, id);
  revalidatePath(`/parent/studio/presentations/${id}`);
}
