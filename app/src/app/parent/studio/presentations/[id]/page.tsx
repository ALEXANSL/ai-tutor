import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentAccess } from "@/server/auth/guards";
import { getDeck } from "@/server/decks/store";
import { reconcileDeck } from "@/server/decks/recovery";
import { DeckProgress } from "@/components/decks/DeckProgress";
import { DeckPlayer } from "@/components/decks/DeckPlayer";
import { deckLessonOptions } from "@/server/decks/placement";
import { changeDeckPlacement, publishDeck, retryDeck } from "@/app/actions/narrated-decks";
import { parentButton, parentInput } from "@/app/parent/ui";
export const maxDuration = 300;
export default async function ParentDeckPage({ params }: { params: Promise<{id: string}> }) {
  const { familyId } = await requireParentAccess();
  const { id } = await params;
  const saved = await getDeck(familyId, id);
  if (!saved) notFound();
  let deck = saved;
  let queueUnavailable = false;
  try { deck = await reconcileDeck(familyId, id, saved); }
  catch { queueUnavailable = true; }
  const pending = deck.slides.findIndex(s => !s.ready);
  const retryMinutes = deck.retry ? Math.max(0, Math.ceil((Date.parse(deck.retry.at) - Date.now()) / 60000)) : 0;
  const plan = deck.generated?.plan;
  const prepared = plan?.slides.filter(slide => slide.drawing.length).length ?? 0;
  const stage = !deck.generated ? undefined : deck.generated.pptxReady ? "Етап: підготовка до перегляду." : !plan ? "Етап: сценарій за матеріалами уроку." : prepared < plan.slides.length ? `Етап: ілюстрації. Підготовлено ${prepared} із ${plan.slides.length}.` : "Етап: оформлення PowerPoint.";
  const options = deck.state === "processing" ? [] : await deckLessonOptions(familyId, deck.subjectId);
  return <main className="mx-auto max-w-5xl space-y-5"><Link href="/parent/studio/presentations">← Мої презентації</Link><h1 className="text-2xl font-bold">{deck.title}</h1>
    {deck.generated?.pptxReady && <a className="underline" href={`/api/presentations/${id}/lesson.pptx?preview=1`}>Завантажити PowerPoint</a>}
    {queueUnavailable && <p role="status">Не вдалося перевірити чергу. Показано останній збережений стан презентації.</p>}
    {deck.state === "processing" ? <p>{deck.topicId ? "Додатковий матеріал вибраного уроку" : "Додатковий матеріал предмета"}</p> :
      <form action={changeDeckPlacement.bind(null, id)} className="flex flex-wrap items-end gap-3"><label>Урок (необов’язково)<select className={parentInput} name="topicId" defaultValue={deck.topicId ?? ""}><option value="">Додатковий матеріал предмета</option>{options.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label><button className={parentButton}>Зберегти прив’язку</button></form>}
    {deck.state === "processing" && deck.retry && <p role="status">{deck.retry.reason} {retryMinutes ? `Автоматична спроба приблизно через ${retryMinutes} хв.` : "Повтор заплановано. Сторінку можна закрити, підготовка продовжується у фоновій черзі."}</p>}
    {deck.state === "processing" && <DeckProgress stage={stage} waiting={!!deck.retry} nextSlide={pending + 1} hasScript={!!deck.slides[pending]?.narration} scripts={deck.slides.filter(s => s.narration).length} done={deck.slides.filter(s => s.ready).length} total={deck.slides.length} />}
    {deck.state === "error" && <><p role="alert">Підготовка зупинилась. {deck.error}</p><form action={retryDeck.bind(null, id)}><button className={parentButton}>Продовжити зі збереженого слайда</button></form></>}
    {deck.state === "ready" && <><p>{deck.published ? (deck.topicId ? "Опубліковано як додатковий матеріал уроку." : "Опубліковано в додаткових матеріалах предмета.") : "Готово до попереднього перегляду."}</p><form action={publishDeck.bind(null, id, !deck.published)}><button className={parentButton}>{deck.published ? "Приховати від дитини" : "Опублікувати дитині"}</button></form><DeckPlayer id={id} scripts={deck.slides.map(s => s.narration)} preview /></>}
  </main>;
}
