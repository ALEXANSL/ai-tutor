"use client";
import Link from "next/link";
import { z } from "zod";
import { STUDIO_MAX_BUDGET, studioRequestSchema } from "@/lib/studio";
import { StudioSourceUpload } from "./StudioSourceUpload";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { saveStudioFormDraftAction, launchStudioFormDraftAction } from "@/app/actions/studio-drafts";
import type { StudioDraftValues } from "@/server/studio/drafts";
import { listSubjectTopicsForVideoAction } from "@/app/actions/video-lessons";
import { withBusySignal } from "@/lib/busy-signal";
import { parentButton, parentInput } from "@/app/parent/ui";
import type { SubjectOption } from "@/server/books/queries";

type InitialDraft = { id: string; revision: number; values: StudioDraftValues; projectId?: string | null; updatedAt?: string };
type Props = {
  subjects: SubjectOption[]; books: { id: string; title: string }[];
  storageKey: string; initialDraft?: InitialDraft | null; initialSaved?: boolean;
  initialSubject?: string; initialTopic?: string; initialTitle?: string; initialGrade?: number;
  /** Prefilled goal, e.g. from a school diary entry; `contextId` keeps its device recovery separate. */
  initialIdea?: string; contextId?: string;
  uploadEnabled?: boolean; initialMaterial?: string;
};
// Recovery is deliberately looser than launch validation, so partially entered
// ranges and empty fields survive. Rebuild from shape to omit launch refinements.
const recoverableValues = z.object({ ...studioRequestSchema.shape,
  title: z.string().max(200), idea: z.string().max(20000),
  age: z.number().finite(), grade: z.number().finite(), lessonCount: z.number().finite(),
  minutes: z.number().finite(), budgetUsd: z.number().finite(),
  pageFrom: z.number().finite().nullable(), pageTo: z.number().finite().nullable(),
}).strict();
const recoverySchema = z.object({
  version: z.literal(1), id: z.string().uuid(), revision: z.number().int().nonnegative().nullable(),
  values: recoverableValues, materialTitle: z.string().max(500),
  base: z.string().max(100000), updatedAt: z.string(),
}).strict();
type Recovery = z.infer<typeof recoverySchema>;
const savedMessage = "Чернетку збережено, генерацію не запущено.";
class DraftActionError extends Error {}

export function StudioCreate(props: Props) {
  // A family/context change remounts all draft refs as well as controlled fields.
  const identity = JSON.stringify([props.storageKey, props.initialDraft?.id ?? null,
    props.initialSubject ?? "", props.initialTopic ?? "", props.initialMaterial ?? "", props.contextId ?? ""]);
  return <StudioCreateSession key={identity} {...props} />;
}

function StudioCreateSession({ subjects, books, storageKey, initialDraft, initialSaved = false,
  initialSubject = "", initialTopic = "", initialTitle = "", initialGrade = 6, initialIdea = "", contextId = "",
  uploadEnabled = false, initialMaterial = "" }: Props) {
  const router = useRouter();
  const defaultValues: StudioDraftValues = {
    mode: initialTopic ? "extension" : "course", targetLanguage: /англій/iu.test(subjects.find(item => item.id === initialSubject)?.name ?? "") ? "en" : /німець/iu.test(subjects.find(item => item.id === initialSubject)?.name ?? "") ? "de" : null,
    title: initialTitle, idea: initialIdea || (initialTopic ? "Поглиб тему базового уроку: поясни складні місця, додай розібрані приклади, цікаві зв’язки та практику. Відділяй матеріал підручника від доповнень із загальних знань ШІ." : ""),
    sourceText: "", subjectId: initialSubject || null, topicId: initialTopic || null,
    materialId: initialMaterial || null, pageFrom: null, pageTo: null,
    age: 12, grade: initialGrade, lessonCount: 1, minutes: 20, budgetUsd: 3,
    narratedDeck: true,
  };
  const [values, setValues] = useState<StudioDraftValues>(initialDraft?.values ?? defaultValues);
  const latest = useRef(values);
  const draftId = useRef<string | null>(initialDraft?.id ?? null);
  const revision = useRef<number | null>(initialDraft?.revision ?? null);
  const persisted = useRef(JSON.stringify(initialDraft?.values ?? defaultValues));
  const contextKey = `${storageKey}:${initialDraft ? `draft:${initialDraft.id}` : `new:${JSON.stringify(contextId ? [initialSubject, initialTopic, initialMaterial, contextId] : [initialSubject, initialTopic, initialMaterial])}`}`;
  const recoveryKey = useRef(contextKey);
  const materialTitle = useRef(books.find(book => book.id === values.materialId)?.title ?? "Збережений матеріал");
  const [availableBooks, setAvailableBooks] = useState(books);
  const [sourceReady, setSourceReady] = useState(!values.materialId);
  const [topics, setTopics] = useState<{ id: string; title: string }[]>(values.topicId ? [{ id: values.topicId, title: initialTitle || "Збережений базовий урок" }] : []);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(initialSaved ? savedMessage : "");
  const [localWarning, setLocalWarning] = useState("");
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const lock = useRef(false), sequence = useRef(0), mounted = useRef(true);

  function storeRecovery(force = false, mirrorContext = false) {
    if (!force && JSON.stringify(latest.current) === persisted.current) return true;
    try {
      draftId.current ??= crypto.randomUUID();
      const snapshot: Recovery = { version: 1, id: draftId.current, revision: revision.current,
        values: latest.current, materialTitle: materialTitle.current, base: persisted.current, updatedAt: new Date().toISOString() };
      const encoded = JSON.stringify(snapshot);
      localStorage.setItem(recoveryKey.current, encoded);
      if (mirrorContext && recoveryKey.current !== contextKey) localStorage.setItem(contextKey, encoded);
      return true;
    } catch { return false; }
  }
  function change<K extends keyof StudioDraftValues>(key: K, value: StudioDraftValues[K]) {
    latest.current = { ...latest.current, [key]: value };
    setValues(latest.current); setNotice("");
    if (!storeRecovery()) setLocalWarning("Автозбереження на цьому пристрої недоступне. Зберігай чернетку кнопкою нижче.");
  }
  function applyRecovery(snapshot: Recovery, asNew = false) {
    draftId.current = asNew ? crypto.randomUUID() : snapshot.id;
    revision.current = asNew ? null : snapshot.revision;
    if (!asNew) persisted.current = snapshot.base;
    latest.current = snapshot.values;
    materialTitle.current = snapshot.materialTitle;
    setValues(snapshot.values);
    if (snapshot.values.materialId) setAvailableBooks(current => current.some(book => book.id === snapshot.values.materialId) ? current : [{ id: snapshot.values.materialId!, title: snapshot.materialTitle || "Збережений матеріал" }, ...current]);
    setSourceReady(!snapshot.values.materialId);
    setNotice("Відновлено незбережене заповнення з цього пристрою. Генерацію не запущено.");
    setRecovery(null);
    storeRecovery();
  }
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      try {
        const raw = localStorage.getItem(contextKey);
        if (!raw) return;
        const parsed = recoverySchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return;
        const snapshot = parsed.data;
        const changedElsewhere = !!initialDraft && (snapshot.id !== initialDraft.id || snapshot.revision !== initialDraft.revision);
        const explicitChoice = !initialDraft && ((initialSubject && snapshot.values.subjectId !== initialSubject)
          || (initialTopic && snapshot.values.topicId !== initialTopic) || (initialMaterial && snapshot.values.materialId !== initialMaterial));
        if (changedElsewhere || explicitChoice) setRecovery(snapshot);
        else applyRecovery(snapshot);
      } catch { setLocalWarning("Автозбереження на цьому пристрої недоступне. Зберігай чернетку кнопкою нижче."); }
    });
    const flush = () => storeRecovery();
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      cancelled = true; mounted.current = false; flush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
    };
    // This keyed form owns one family/context; refs hold every latest keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const id = values.subjectId;
    if (!id) return;
    const request = ++sequence.current;
    let active = true;
    void listSubjectTopicsForVideoAction(id).then(result => { if (active && request === sequence.current) setTopics(result); })
      .catch(() => { if (active) setError("Не вдалося завантажити теми. Спробуй ще раз."); });
    return () => { active = false; };
  }, [values.subjectId]);

  const mode = values.mode === "revision" ? "extension" : values.mode;
  const targetLanguage = values.targetLanguage ?? "";
  const { title, idea, sourceText, age, minutes } = values;
  const count = values.lessonCount, budget = values.budgetUsd;
  const subjectId = values.subjectId ?? "", topicId = values.topicId ?? "", materialId = values.materialId ?? "";
  const pageFrom = values.pageFrom === null ? "" : String(values.pageFrom), pageTo = values.pageTo === null ? "" : String(values.pageTo);
  const setMode = (value: "course" | "extension") => change("mode", value);
  const setTargetLanguage = (value: "" | "en" | "de") => change("targetLanguage", value || null);
  const setTitle = (value: string) => change("title", value);
  const setIdea = (value: string) => change("idea", value);
  const setSourceText = (value: string) => change("sourceText", value);
  const setTopicId = (value: string) => change("topicId", value || null);
  const setMaterialId = (value: string) => change("materialId", value || null);
  const setPageFrom = (value: string) => change("pageFrom", value ? Number(value) : null);
  const setPageTo = (value: string) => change("pageTo", value ? Number(value) : null);
  const setAge = (value: number) => change("age", value);
  const setCount = (value: number) => change("lessonCount", value);
  const setMinutes = (value: number) => change("minutes", value);
  const setBudget = (value: number) => change("budgetUsd", value);
  const narratedDeck = values.narratedDeck ?? false;
  function subject(value: string) {
    ++sequence.current;
    const name = subjects.find(item => item.id === value)?.name ?? "";
    latest.current = { ...latest.current, subjectId: value || null, topicId: null,
      targetLanguage: /англій/iu.test(name) ? "en" : /німець/iu.test(name) ? "de" : null };
    setValues(latest.current); setTopics([]); setNotice(""); storeRecovery();
  }
  async function persistCurrent(clearDevice = true) {
    draftId.current ??= crypto.randomUUID();
    const result = await saveStudioFormDraftAction({ id: draftId.current, revision: revision.current, values: latest.current });
    if (result.status !== "ok") throw new DraftActionError(result.message);
    revision.current = result.revision;
    persisted.current = JSON.stringify(latest.current);
    const previousKey = recoveryKey.current;
    recoveryKey.current = `${storageKey}:draft:${result.id}`;
    if (clearDevice) {
      try { localStorage.removeItem(previousKey); localStorage.removeItem(contextKey); localStorage.removeItem(recoveryKey.current); } catch { /* Server copy is already saved. */ }
    } else storeRecovery(true, true);
    return result;
  }
  async function saveDraft() {
    if (lock.current) return;
    lock.current = true; setPending(true); setError(""); setNotice("");
    try {
      const result = await persistCurrent();
      if (!mounted.current) return;
      setNotice(savedMessage);
      router.replace(`/parent/studio/new?draft=${result.id}&saved=1`, { scroll: false });
    } catch (failure) { if (mounted.current) setError(failure instanceof DraftActionError ? failure.message : "Не вдалося зберегти чернетку. Заповнення залишилося у формі; перевір з’єднання і спробуй ще раз."); }
    finally { lock.current = false; if (mounted.current) setPending(false); }
  }
  async function submit() {
    if (lock.current || !sourceReady) return;
    lock.current = true; setPending(true); setError(""); setNotice("");
    try {
      const request = { ...latest.current, lessonCount: mode === "extension" ? 1 : latest.current.lessonCount, topicId: mode === "extension" ? latest.current.topicId : null };
      const checked = studioRequestSchema.safeParse(request);
      if (!checked.success) { setError(checked.error.issues[0]?.message ?? "Перевір заповнення форми."); return; }
      const saved = await persistCurrent(false);
      const result = await withBusySignal(() => launchStudioFormDraftAction({ id: saved.id, revision: saved.revision }));
      if (!mounted.current) return;
      if (result.status === "ok") {
        try { localStorage.removeItem(recoveryKey.current); localStorage.removeItem(contextKey); } catch { /* Durable project exists. */ }
        router.push(`/parent/studio/${result.id}`);
      } else {
        setError(result.message); setNotice("Чернетку збережено. Підготовку не вдалося запустити — заповнення не втрачено.");
        router.replace(`/parent/studio/new?draft=${saved.id}`, { scroll: false });
      }
    } catch (failure) {
      if (mounted.current) { setError(failure instanceof DraftActionError ? failure.message : "Не вдалося запустити підготовку. Перевір збережену чернетку перед повторною спробою."); if (revision.current !== null && draftId.current) router.replace(`/parent/studio/new?draft=${draftId.current}`, { scroll: false }); }
    } finally { lock.current = false; if (mounted.current) setPending(false); }
  }
  return <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-5">
    {recovery && <section className="space-y-3 rounded-2xl border border-p-line bg-p-surface p-4" aria-label="Відновлення заповнення"><p className="text-sm">На цьому пристрої є незбережене заповнення «{recovery.values.title || "Без назви"}». Воно відрізняється від поточного вибору або збережена чернетка вже змінилася. Поточні поля не замінено.</p><button type="button" onClick={() => applyRecovery(recovery, true)} className={parentButton}>Відновити як окрему чернетку</button></section>}
    <fieldset disabled={pending} className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">{([["course", "Новий урок або курс", "З ідеї, власного тексту чи книги"], ["extension", "Розширити базовий урок", "Більше пояснень, прикладів і практики"]] as const).map(([value, label, description]) => <label key={value} className={`flex min-h-20 cursor-pointer items-start gap-3 rounded-2xl border p-4 ${mode === value ? "border-p-primary bg-p-surface" : "border-p-line"}`}><input type="radio" name="studio-mode" checked={mode === value} onChange={() => setMode(value)} className="mt-1" /><span><strong className="block text-sm">{label}</strong><span className="text-xs text-p-muted">{description}</span></span></label>)}</div>
      <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-bold">{mode === "extension" ? "Предмет базового уроку" : "Додати до предмета або курсу (необов’язково)"}<select aria-label="Предмет або курс" value={subjectId} onChange={event => void subject(event.target.value)} required={mode === "extension"} className={`${parentInput} mt-2`}><option value="">{mode === "extension" ? "Обери предмет" : "Створити окремий новий курс"}</option>{subjectId && !subjects.some(item => item.id === subjectId) && <option value={subjectId}>Збережений предмет</option>}{subjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {mode === "extension" && <label className="text-sm font-bold">Базовий урок<select aria-label="Базовий урок" value={topicId} required onChange={event => { setTopicId(event.target.value); if (!idea) setIdea("Поглиб тему базового уроку: додай пояснення, розібрані приклади й практику, використовуючи матеріали та загальні знання ШІ."); if (!title) setTitle(topics.find(topic => topic.id === event.target.value)?.title ?? ""); }} className={`${parentInput} mt-2`}><option value="">Обери тему</option>{topicId && !topics.some(item => item.id === topicId) && <option value={topicId}>Збережений базовий урок</option>}{topics.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}</div>
      <label className="block text-sm font-bold">Мова, яку вивчаємо<select aria-label="Мова, яку вивчаємо" value={targetLanguage} onChange={event => setTargetLanguage(event.target.value as "" | "en" | "de")} className={`${parentInput} mt-2`}><option value="">Звичайний предмет</option><option value="en">Англійська — пояснення українською</option><option value="de">Німецька — пояснення українською</option></select></label>
      {targetLanguage && <p className="text-sm text-p-muted">Пояснення й розбір завдань — українською. Приклади, слова та діалоги для слухання — мовою оригіналу, без кириличної транслітерації. Підручник необов’язковий.</p>}
      <label className="block text-sm font-bold">Назва<input aria-label="Назва" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required placeholder="Наприклад, «Створюємо першу гру в Roblox»" className={`${parentInput} mt-2`} /></label>
      <label className="block text-sm font-bold">Що дитина має зрозуміти або навчитися робити?<textarea aria-label="Що дитина має зрозуміти або навчитися робити?" value={idea} onChange={event => setIdea(event.target.value)} maxLength={20000} required rows={5} placeholder="Опиши тему, результат, підготовку дитини та побажання. Для практичної роботи — доступні матеріали й інструменти." className={`${parentInput} mt-2 py-3 font-normal`} /></label>
      <fieldset className="space-y-3 rounded-2xl border border-p-line p-4"><legend className="px-1 text-sm font-bold">Що зробити</legend>
        <p className="flex items-start gap-3 text-sm"><input type="checkbox" checked disabled aria-label="Урок з поясненнями, вправами й тестом" className="mt-1" /><span><strong className="block">Урок з поясненнями, вправами й тестом</strong><span className="text-xs text-p-muted">Основа для всіх інших форматів, готується завжди.</span></span></p>
        <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" aria-label="Презентація з озвучкою та ілюстраціями" checked={narratedDeck} onChange={event => change("narratedDeck", event.target.checked)} className="mt-1" /><span><strong className="block">Презентація з озвучкою та ілюстраціями</strong><span className="text-xs text-p-muted">Після того як ти опублікуєш уроки, Майстерня сама підготує презентацію до кожного. Оплачується із загального бюджету ШІ, дитина побачить її лише після твого перегляду й публікації.</span></span></label>
      </fieldset>
      <p className="text-sm text-p-muted">Кількість уроків визначає твоя навчальна мета. Довгий план готується частинами, уроки — послідовно. Витрати обмежує вказаний тобою бюджет; ліміт не збільшується автоматично. Перевірки знань — квізи з натисканням на варіант відповіді.</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><label className="text-sm font-bold">Вік<input aria-label="Вік дитини" type="number" min={7} max={18} value={age} onChange={event => setAge(Number(event.target.value))} className={`${parentInput} mt-2`} /></label><label className="text-sm font-bold">Уроків<input type="number" min={1} step={1} aria-label="Кількість уроків" value={mode === "extension" ? 1 : count} disabled={mode === "extension"} onChange={event => setCount(Number(event.target.value))} className={`${parentInput} mt-2`} /></label><label className="text-sm font-bold">Хвилин на урок<input aria-label="Хвилин на урок" type="number" min={10} max={45} value={minutes} onChange={event => setMinutes(Number(event.target.value))} className={`${parentInput} mt-2`} /></label><label className="text-sm font-bold">Ліміт підготовки, $<input aria-label="Ліміт підготовки" type="number" min={0.5} max={STUDIO_MAX_BUDGET} step={0.5} value={budget} onChange={event => setBudget(Number(event.target.value))} className={`${parentInput} mt-2`} /></label></div>
      <details open className="rounded-2xl border border-p-line p-4"><summary className="min-h-8 cursor-pointer text-sm font-bold">Матеріали для уроку: файл, бібліотека або текст (необов’язково)</summary><div className="mt-4 space-y-4">
        <Link href="/parent/studio/presentations" className="inline-flex min-h-11 items-center text-sm font-bold text-p-primary">Показати авторську PPTX з озвученням →</Link>
        <StudioSourceUpload enabled={uploadEnabled} selectedId={materialId} onBusy={value => { setPending(value); lock.current = value; }} onReady={setSourceReady} onTasks={text => { const next = `${idea}\n\nРозбери ці вправи з поясненнями українською, збережи їхні номери та оригінальну мову:\n${text}`; if (next.length > 20000) setError("Побажання перевищують 20 000 символів. Обери менше вправ; текст не обрізано."); else setIdea(next); }} onSelect={book => { materialTitle.current = book.title; setAvailableBooks(current => current.some(item => item.id === book.id) ? current : [book, ...current]); setMaterialId(book.id); setPageFrom(""); setPageTo(""); setSourceReady(false); }} />
        <label className="block text-sm font-bold">Книга або матеріал із бібліотеки<select aria-label="Книга з бібліотеки" value={materialId} onChange={event => { materialTitle.current = availableBooks.find(book => book.id === event.target.value)?.title ?? "Збережений матеріал"; setMaterialId(event.target.value); setSourceReady(!event.target.value); setPageFrom(""); setPageTo(""); }} className={`${parentInput} mt-2`}><option value="">Без окремого матеріалу</option>{materialId && !availableBooks.some(book => book.id === materialId) && <option value={materialId}>Збережений матеріал</option>}{availableBooks.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
        <details className="rounded-xl border border-p-line p-3"><summary className="cursor-pointer text-sm font-bold">Уточнити сторінки джерела (необов’язково)</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-sm">Сторінка / частина від<input aria-label="Сторінка від" type="number" min={1} max={10000} value={pageFrom} disabled={!materialId} onChange={event => setPageFrom(event.target.value)} className={`${parentInput} mt-2`} /></label><label className="text-sm">До сторінки / частини<input aria-label="Сторінка до" type="number" min={1} max={10000} value={pageTo} disabled={!materialId} onChange={event => setPageTo(event.target.value)} className={`${parentInput} mt-2`} /></label></div></details>
        <p className="text-xs leading-relaxed text-p-muted">Майстерня спочатку використовує вже підготовлені матеріали предмета або базового уроку. Якщо їх бракує, бере потрібне з розпізнаної книги; загальні знання ШІ доступні для пояснень і доповнень. Сторінки можна не вказувати: це не означає повторний аналіз усієї книги за замовчуванням. Для PDF це сторінки файла, для PPTX — слайди, для EPUB — розділи, для DOCX — частини за заголовками.</p>
        <label className="block text-sm font-bold">Власні матеріали<textarea aria-label="Власні матеріали" value={sourceText} maxLength={40000} onChange={event => setSourceText(event.target.value)} rows={7} className={`${parentInput} mt-2 py-3 font-normal`} /></label>
      </div></details>
      {!sourceReady && <p role="status" className="text-sm text-p-muted">Підготовку можна запустити після розпізнавання вибраного матеріалу. Чернетку можна зберегти вже зараз.</p>}
      <p className="text-sm leading-relaxed text-p-muted">Опрацювання джерел і підготовка плану — платні виклики в межах бюджету проєкту. Для підготовки Майстерня може передавати відповідні матеріали в OpenAI, Gemini та Claude. Для тривалого запиту автора OpenAI тимчасово зберігає відповідь. Майстерня сама складе план, підготує уроки та перевірить їх. Готові матеріали ти переглянеш перед публікацією. Публікація для дитини — окрема дія. Цей ліміт стосується підготовки й доопрацювань; голос і розмови під час навчання враховуються окремо в загальному бюджеті застосунку.</p>
      <div className="flex flex-wrap gap-3"><button type="button" onClick={() => void saveDraft()} className={`${parentButton} border border-p-line bg-p-surface text-p-primary`}>Зберегти чернетку</button><button type="submit" disabled={!sourceReady} className={`${parentButton} disabled:opacity-50`}>{pending ? "Зберігаємо…" : "Запустити підготовку"}</button></div>
      <p className="text-xs text-p-muted">Чернетку можна зберегти з незаповненими полями й продовжити пізніше. Підготовка ШІ починається лише кнопкою «Запустити підготовку». Незбережене заповнення автоматично зберігається на цьому пристрої, зокрема при переході в дитячий режим; вибрані, але ще не завантажені файли повторно обери після повернення.</p>
    </fieldset>
    {notice && <p role="status" className="rounded-xl border border-p-line p-4 text-sm">{notice}</p>}
    {localWarning && <p role="status" className="text-sm text-p-muted">{localWarning}</p>}
    {error && <p role="alert" className="rounded-xl border border-p-line p-4 text-sm">{error}</p>}
  </form>;
}
