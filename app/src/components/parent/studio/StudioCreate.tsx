"use client";
import { StudioPhotoSource } from "./StudioPhotoSource";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createStudioAction } from "@/app/actions/studio";
import { listSubjectTopicsForVideoAction } from "@/app/actions/video-lessons";
import { withBusySignal } from "@/lib/busy-signal";
import { parentButton, parentInput } from "@/app/parent/ui";
import type { SubjectOption } from "@/server/books/queries";
export function StudioCreate({ subjects, books, initialSubject = "", initialTopic = "", initialTitle = "", initialGrade = 6 }: { subjects: SubjectOption[]; books: { id: string; title: string }[]; initialSubject?: string; initialTopic?: string; initialTitle?: string; initialGrade?: number }) {
  const router = useRouter();
  const [targetLanguage, setTargetLanguage] = useState<"" | "en" | "de">(() => { const name = subjects.find(item => item.id === initialSubject)?.name ?? ""; return /англій/iu.test(name) ? "en" : /німець/iu.test(name) ? "de" : ""; });
  const [mode, setMode] = useState<"course" | "extension">(initialTopic ? "extension" : "course");
  const [title, setTitle] = useState(initialTitle); const [idea, setIdea] = useState(initialTopic ? "Поглиб тему базового уроку: поясни складні місця, додай розібрані приклади, цікаві зв’язки та практику. Відділяй матеріал підручника від доповнень із загальних знань ШІ." : ""); const [sourceText, setSourceText] = useState("");
  const [subjectId, setSubjectId] = useState(initialSubject); const [topicId, setTopicId] = useState(initialTopic);
  const [topics, setTopics] = useState<{ id: string; title: string }[]>(initialTopic ? [{ id: initialTopic, title: initialTitle || "Вибраний базовий урок" }] : []);
  const [materialId, setMaterialId] = useState(""); const [pageFrom, setPageFrom] = useState(""); const [pageTo, setPageTo] = useState("");
  const [age, setAge] = useState(12); const grade = initialGrade; const [count, setCount] = useState(1); const [minutes, setMinutes] = useState(20); const [budget, setBudget] = useState(3);
  const [pending, setPending] = useState(false); const [error, setError] = useState(""); const sequence = useRef(0); const lock = useRef(false);
  const submission = useRef<{ key: string; id: string } | null>(null);
  async function subject(value: string) {
    const request = ++sequence.current; const name = subjects.find(item => item.id === value)?.name ?? ""; setTargetLanguage(/англій/iu.test(name) ? "en" : /німець/iu.test(name) ? "de" : ""); setSubjectId(value); setTopicId(""); setTopics([]);
    if (!value) return;
    try { const result = await listSubjectTopicsForVideoAction(value); if (request === sequence.current) setTopics(result); }
    catch { if (request === sequence.current) setError("Не вдалося завантажити теми. Спробуй ще раз."); }
  }
  useEffect(() => {
    if (!initialSubject || initialTopic) return;
    let active = true;
    void listSubjectTopicsForVideoAction(initialSubject).then(value => { if (active) setTopics(value); }).catch(() => { if (active) setError("Не вдалося завантажити теми."); });
    return () => { active = false; };
  }, [initialSubject, initialTopic]);
  async function upload(file: File) {
    if (!file.size || file.size > 3 * 1024 * 1024) { setError("Обери файл до 3 МБ. Для великої книги скористайся бібліотекою."); return; }
    if (lock.current) return; lock.current = true; setPending(true); setError("");
    try { const form = new FormData(); form.set("file", file); const result = await withBusySignal(async () => { const response = await fetch("/api/parent/studio/source", { method: "POST", body: form }); return await response.json() as { status: "ok"; text: string } | { status: "error"; message: string }; }); if (result.status === "ok") setSourceText(result.text); else setError(result.message); }
    catch { setError("Не вдалося прочитати файл. Встав потрібний текст або вибери книгу з бібліотеки."); }
    finally { lock.current = false; setPending(false); }
  }
  async function submit() {
    if (lock.current) return; lock.current = true; setPending(true); setError("");
    try {
      const request = { mode, targetLanguage: targetLanguage || null, title, idea, age, grade, lessonCount: mode === "extension" ? 1 : count, minutes, budgetUsd: budget, subjectId: subjectId || null, topicId: mode === "extension" ? topicId || null : null, materialId: materialId || null, pageFrom: pageFrom ? Number(pageFrom) : null, pageTo: pageTo ? Number(pageTo) : null, sourceText };
      const key = JSON.stringify(request);
      if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
      const result = await withBusySignal(() => createStudioAction({ requestId: submission.current!.id, request }));
      if (result.status === "ok") router.push(`/parent/studio/${result.id}`); else setError(result.message);
    } catch { setError("Не вдалося створити чернетку. Перевір з’єднання і список проєктів перед повторною спробою."); }
    finally { lock.current = false; setPending(false); }
  }
  return <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-5">
    <fieldset disabled={pending} className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">{([["course", "Новий урок або мінікурс", "З ідеї, власного тексту чи книги"], ["extension", "Розширити базовий урок", "Більше пояснень, прикладів і практики"]] as const).map(([value, label, description]) => <label key={value} className={`flex min-h-20 cursor-pointer items-start gap-3 rounded-2xl border p-4 ${mode === value ? "border-p-primary bg-p-surface" : "border-p-line"}`}><input type="radio" name="studio-mode" checked={mode === value} onChange={() => setMode(value)} className="mt-1" /><span><strong className="block text-sm">{label}</strong><span className="text-xs text-p-muted">{description}</span></span></label>)}</div>
      <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-bold">{mode === "extension" ? "Предмет базового уроку" : "Додати до предмета або курсу (необов’язково)"}<select aria-label="Предмет або курс" value={subjectId} onChange={event => void subject(event.target.value)} required={mode === "extension"} className={`${parentInput} mt-2`}><option value="">{mode === "extension" ? "Обери предмет" : "Створити окремий новий курс"}</option>{subjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {mode === "extension" && <label className="text-sm font-bold">Базовий урок<select aria-label="Базовий урок" value={topicId} required onChange={event => { setTopicId(event.target.value); if (!idea) setIdea("Поглиб тему базового уроку: додай пояснення, розібрані приклади й практику, використовуючи матеріали та загальні знання ШІ."); if (!title) setTitle(topics.find(topic => topic.id === event.target.value)?.title ?? ""); }} className={`${parentInput} mt-2`}><option value="">Обери тему</option>{topics.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}</div>
      <label className="block text-sm font-bold">Мова, яку вивчаємо<select aria-label="Мова, яку вивчаємо" value={targetLanguage} onChange={event => setTargetLanguage(event.target.value as "" | "en" | "de")} className={`${parentInput} mt-2`}><option value="">Звичайний предмет</option><option value="en">Англійська — пояснення українською</option><option value="de">Німецька — пояснення українською</option></select></label>
      {targetLanguage && <p className="text-sm text-p-muted">Пояснення й розбір завдань — українською. Приклади, слова та діалоги для слухання — мовою оригіналу, без кириличної транслітерації. Підручник необов’язковий.</p>}
      <label className="block text-sm font-bold">Назва<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required placeholder="Наприклад, «Створюємо першу гру в Roblox»" className={`${parentInput} mt-2`} /></label>
      <label className="block text-sm font-bold">Що дитина має зрозуміти або навчитися робити?<textarea aria-label="Що дитина має зрозуміти або навчитися робити?" value={idea} onChange={event => setIdea(event.target.value)} maxLength={20000} required rows={5} placeholder="Опиши тему, результат, підготовку дитини та побажання. Для практичної роботи — доступні матеріали й інструменти." className={`${parentInput} mt-2 py-3 font-normal`} /></label>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4"><label className="text-sm font-bold">Вік<input aria-label="Вік дитини" type="number" min={7} max={18} value={age} onChange={event => setAge(Number(event.target.value))} className={`${parentInput} mt-2`} /></label><label className="text-sm font-bold">Уроків<input type="number" min={1} max={6} value={mode === "extension" ? 1 : count} disabled={mode === "extension"} onChange={event => setCount(Number(event.target.value))} className={`${parentInput} mt-2`} /></label><label className="text-sm font-bold">Хвилин на урок<input type="number" min={10} max={45} value={minutes} onChange={event => setMinutes(Number(event.target.value))} className={`${parentInput} mt-2`} /></label><label className="text-sm font-bold">Ліміт підготовки, $<input type="number" min={0.5} max={25} step={0.5} value={budget} onChange={event => setBudget(Number(event.target.value))} className={`${parentInput} mt-2`} /></label></div>
      <StudioPhotoSource disabled={pending} onBusy={value => { setPending(value); lock.current = value; }} onText={text => { const next = sourceText.trim() ? `${sourceText}\n\n${text}` : text; if (next.length > 40000) setError("Матеріалів більше ніж 40 000 символів. Збережи частину окремо або очисть поле перед додаванням; текст не обрізано."); else setSourceText(next); }} onTasks={text => { const next = `${idea}\n\nРозбери ці вправи з поясненнями українською, збережи їхні номери та оригінальну мову:\n${text}`; if (next.length > 20000) setError("Побажання перевищують 20 000 символів. Обери менше вправ; текст не обрізано."); else setIdea(next); }} />
      <details open={!!sourceText} className="rounded-2xl border border-p-line p-4"><summary className="min-h-8 cursor-pointer text-sm font-bold">Джерела: книга, сторінки, файл або текст (необов’язково)</summary><div className="mt-4 space-y-4">
        <label className="block text-sm font-bold">Книга з бібліотеки<select aria-label="Книга з бібліотеки" value={materialId} onChange={event => { setMaterialId(event.target.value); setPageFrom(""); setPageTo(""); }} className={`${parentInput} mt-2`}><option value="">Без окремої книги</option>{books.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm">Сторінка індексу від<input type="number" min={1} max={10000} value={pageFrom} disabled={!materialId} onChange={event => setPageFrom(event.target.value)} className={`${parentInput} mt-2`} /></label><label className="text-sm">До сторінки<input type="number" min={1} max={10000} value={pageTo} disabled={!materialId} onChange={event => setPageTo(event.target.value)} className={`${parentInput} mt-2`} /></label></div>
        <p className="text-xs leading-relaxed text-p-muted">Без діапазону шукаємо відповідні фрагменти за темою. Це не означає читання всієї книги. Для великої книги спочатку додай її до <Link href="/parent/books" className="underline">бібліотеки</Link>.</p>
        <label className="block text-sm font-bold">Додати невеликий файл<input aria-label="Файл для майстерні" type="file" accept=".txt,.md,.pdf" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ""; if (selected) void upload(selected); }} className="mt-2 block min-h-11 w-full max-w-full rounded-xl border border-p-line p-2 text-sm font-normal" /></label><p className="text-xs text-p-muted">TXT / MD / текстовий PDF до 3 МБ; до 40 000 символів. Текст із файлу замінить поле нижче. Для скану скористайся блоком «Фото або скан сторінки» вище; велику книгу додай до бібліотеки.</p>
        <label className="block text-sm font-bold">Власні матеріали<textarea aria-label="Власні матеріали" value={sourceText} maxLength={40000} onChange={event => setSourceText(event.target.value)} rows={7} className={`${parentInput} mt-2 py-3 font-normal`} /></label>
      </div></details>
      <p className="text-sm leading-relaxed text-p-muted">Підготовка плану — платний виклик OpenAI в межах цього ліміту. Спочатку переглянеш план і знайдені джерела; повні уроки почнуть готуватися після твого погодження. Публікація для дитини — окрема дія. Цей ліміт стосується підготовки й доопрацювань; голос і розмови під час навчання враховуються окремо в загальному бюджеті застосунку.</p>
      <button type="submit" className={parentButton}>{pending ? "Зберігаємо та готуємо…" : "Створити чернетку й підготувати план"}</button>
    </fieldset>
    {error && <p role="alert" className="rounded-xl border border-p-line p-4 text-sm">{error}</p>}
  </form>;
}
