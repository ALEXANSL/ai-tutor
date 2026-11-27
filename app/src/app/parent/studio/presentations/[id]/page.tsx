import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentAccess } from "@/server/auth/guards";
import { getDeck } from "@/server/decks/store";
import { reconcileDeck } from "@/server/decks/recovery";
import { DeckProgress } from "@/components/decks/DeckProgress";
import { DeckPlayer } from "@/components/decks/DeckPlayer";
import { deckLessonOptions } from "@/server/decks/placement";
import { changeDeckPlacement, publishDeck, redrawDeckIllustrations, remakeDeckVideo, remakeDeckWithTeam, retryDeck, revoiceDeck } from "@/app/actions/narrated-decks";
import { DECK_TEAM_STAGE, REVIEW_CRITERIA, REVIEW_LABELS, nextTeamRole } from "@/lib/deck-team";
import { deckImageEstimateUsd } from "@/server/decks/visuals";
import { loadIllustrationFailures } from "@/server/decks/illustration-failures";
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
  const prepared = plan?.slides.filter(slide => slide.visual).length ?? 0;
  const illustrated = plan?.slides.filter(slide => slide.visual?.kind === "ai" || slide.visual?.kind === "photo" || slide.visual?.kind === "map").length ?? 0;
  const redrawCost = plan ? deckImageEstimateUsd(plan.slides.length) : 0;
  const stage = !deck.generated ? undefined : deck.generated.pptxReady ? "Етап: підготовка до перегляду." : !plan ? `Етап: ${DECK_TEAM_STAGE[nextTeamRole(deck.generated.team) ?? "review"]}` : prepared < plan.slides.length ? `Етап: ілюстрації до слайдів. Готово ${prepared} із ${plan.slides.length}.` : "Етап: оформлення PowerPoint.";
  const failures = deck.state === "ready" && plan && illustrated < plan.slides.length ? await loadIllustrationFailures(familyId, id) : [];
  const team = deck.generated?.team;
  const options = deck.state === "processing" ? [] : await deckLessonOptions(familyId, deck.subjectId);
  return <main className="mx-auto max-w-5xl space-y-5"><Link href="/parent/studio/presentations">← Мої презентації</Link><h1 className="text-2xl font-bold">{deck.title}</h1>
    {deck.generated?.pptxReady && <a className="underline" href={`/api/presentations/${id}/lesson.pptx?preview=1`}>Завантажити PowerPoint</a>}
    {queueUnavailable && <p role="status">Не вдалося перевірити чергу. Показано останній збережений стан презентації.</p>}
    {deck.state === "processing" ? <p>{deck.topicId ? "Додатковий матеріал вибраного уроку" : "Додатковий матеріал предмета"}</p> :
      <form action={changeDeckPlacement.bind(null, id)} className="flex flex-wrap items-end gap-3"><label>Урок (необов’язково)<select className={parentInput} name="topicId" defaultValue={deck.topicId ?? ""}><option value="">Додатковий матеріал предмета</option>{options.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></label><button className={parentButton}>Зберегти прив’язку</button></form>}
    {deck.state === "processing" && deck.retry && <p role="status">{deck.retry.reason} {retryMinutes ? `Автоматична спроба приблизно через ${retryMinutes} хв.` : "Повтор заплановано. Сторінку можна закрити, підготовка продовжується у фоновій черзі."}</p>}
    {deck.state === "processing" && <DeckProgress stage={stage} waiting={!!deck.retry} nextSlide={pending + 1} hasScript={!!deck.slides[pending]?.narration} scripts={deck.slides.filter(s => s.narration).length} done={deck.slides.filter(s => s.ready).length} total={deck.slides.length} />}
    {deck.state === "error" && <><p role="alert">Підготовка зупинилась. {deck.error}</p><form action={retryDeck.bind(null, id)}><button className={parentButton}>Продовжити зі збереженого слайда</button></form></>}
    {deck.state === "ready" && <><p>{deck.published ? (deck.topicId ? "Опубліковано як додатковий матеріал уроку." : "Опубліковано в додаткових матеріалах предмета.") : "Готово до попереднього перегляду."}</p><form action={publishDeck.bind(null, id, !deck.published)}><button className={parentButton}>{deck.published ? "Приховати від дитини" : "Опублікувати дитині"}</button></form><DeckPlayer id={id} scripts={deck.slides.map(s => s.narration)} preview /><section aria-label="Відео з презентації" className="space-y-2">
      {deck.video?.state === "ready" ? <p><a className={`${parentButton} inline-flex items-center`} href={`/api/presentations/${id}/lesson.mp4?preview=1`}>Завантажити відео MP4</a>{deck.video.bytes ? <span className="ml-3 text-sm">{Math.max(1, Math.round(deck.video.bytes / 1048576))} МБ</span> : null}</p>
        : deck.video?.state === "error" ? <><p role="alert">Відео не вдалося зробити. {deck.video.error}</p><form action={remakeDeckVideo.bind(null, id)}><button className={parentButton}>Спробувати ще раз</button></form></>
        : <p role="status">Відео MP4 готується на сервері автоматично, зазвичай до хвилини. Сторінку можна закрити, файл з’явиться тут.</p>}
    </section>
      <form action={revoiceDeck.bind(null, id)} className="space-y-1"><p className="text-sm">Переозвучити тим самим текстом поточним голосом (ElevenLabs, якщо налаштовано). Слайди й ілюстрації лишаться, відео збереться заново. Приблизно {Math.ceil(deck.slides.reduce((n, s) => n + s.narration.length, 0) / 1000)} тис. символів із місячного ліміту голосу.</p><button className={parentButton}>Переозвучити</button></form>
      {team?.review && <section aria-label="Як команда готувала урок" className="space-y-1 text-sm"><p className="font-semibold">Рецензія команди ШІ{team.edited ? " (зауваження виправлено редактором)" : ""}</p><p>{team.review.summary}</p><p>{REVIEW_CRITERIA.map(key => `${REVIEW_LABELS[key]} ${team.review!.scores[key]}/5`).join(" · ")}</p>{team.models && <p className="opacity-70">Моделі: {Object.entries(team.models).map(([role, model]) => `${role} — ${model}`).join(", ")}</p>}</section>}
      {deck.generated && <form action={remakeDeckWithTeam.bind(null, id)} className="space-y-1"><p className="text-sm">Переробити урок командою ШІ (аналітик, педагогічна рада з психологом, учитель-оповідач, художній директор, незалежний рецензент). Новий сценарій, картинки й озвучення; приблизно до $1 і {Math.ceil(deck.slides.reduce((n, s) => n + s.narration.length, 0) / 1000) || 7} тис. символів голосу.</p><button className={parentButton}>Переробити командою ШІ</button></form>}
      {plan && <form action={redrawDeckIllustrations.bind(null, id)} className="space-y-1"><p className="text-sm">Ілюстрації за темою: {illustrated} із {plan.slides.length} слайдів. Можна намалювати їх заново: сценарій і озвучка лишаться, оплачуються лише нові картинки{redrawCost ? ` (приблизно ${"$" + redrawCost.toFixed(2)})` : ""}.</p>{failures.length > 0 && <div role="status" className="text-sm"><p>Чому частина слайдів без ілюстрацій:</p><ul className="list-disc pl-5">{failures.map(f => <li key={`${f.provider}-${f.model}-${f.code}`}>{f.provider} / {f.model}: {f.code ? `HTTP ${f.code}, ` : ""}{f.reason} ({f.count})</li>)}</ul></div>}<button className={parentButton}>Перемалювати ілюстрації</button></form>}
    </>}
  </main>;
}
