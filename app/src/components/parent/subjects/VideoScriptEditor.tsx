"use client";
import { useRef, useState } from "react";
import { generateVideoScriptAction } from "@/app/actions/video-script";
import { estimatedVideoSeconds, exportVideoScript, type VideoDraft, type VideoExport } from "@/lib/video-script";

const views: { id: VideoExport; label: string }[] = [
  { id: "brief", label: "Повний промпт Pictory" },
  { id: "narration", label: "Лише озвучення" },
  { id: "visuals", label: "Візуальні промпти" },
];
export function VideoScriptEditor({ subjectId, topicId, sourceHash, initialDraft }: { subjectId: string; topicId: string; sourceHash: string; initialDraft: VideoDraft | null }) {
  const [draft, setDraft] = useState(initialDraft);
  const [minutes, setMinutes] = useState(initialDraft?.minutes ?? 5);
  const [notes, setNotes] = useState(initialDraft?.notes ?? "");
  const [mode, setMode] = useState<VideoExport>("brief");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const text = draft ? exportVideoScript(draft, mode) : "";
  async function generate() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await generateVideoScriptAction({ subjectId, topicId, minutes, notes });
      if (result.status === "error") setError(result.message);
      else {
        setDraft(result.draft);
        setNotice(result.saved ? "Сценарій збережено. Його можна відкрити тут пізніше без повторної генерації." : "Сценарій готовий, але зберегти його в застосунку не вдалося. Завантажте TXT, щоб не втратити результат.");
      }
    } catch { setError("Не вдалося отримати сценарій. Перевірте з’єднання. Попередній результат залишився на екрані."); }
    finally { lock.current = false; setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setNotice("Скопійовано."); }
    catch { setNotice("Копіювання недоступне. Виділіть текст у полі нижче або завантажте TXT."); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = `pictory-${topicId}-${mode}.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="min-w-0 space-y-4">
    <p className="text-sm">Сцени, точний текст диктора й інструкції для візуалізації. Без нових фактів поза уроком і без написів у кадрі.</p>
    <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
      <label className="flex flex-col gap-1 text-sm font-bold">Тривалість, хвилин
        <select value={minutes} disabled={busy} onChange={event => setMinutes(Number(event.target.value))} className="min-h-11 rounded-xl border border-p-line bg-p-bg px-3 font-normal">{[2, 3, 5, 8, 10, 12].map(value => <option key={value} value={value}>{value}</option>)}</select>
      </label>
      <label className="flex flex-col gap-1 text-sm font-bold">Побажання до подачі (необов’язково)
        <textarea value={notes} disabled={busy} maxLength={1200} onChange={event => setNotes(event.target.value)} rows={3} placeholder="Наприклад: спокійний темп, більше крупних планів, акцент на причинно-наслідкових зв’язках" className="w-full rounded-xl border border-p-line bg-p-bg p-3 font-normal" />
      </label>
    </div>
    <p className="text-xs text-p-muted">Кнопка запускає платний запит OpenAI в межах бюджету застосунку. Відео генерується окремо у Pictory. Тривалість орієнтовна; голос обирається у Pictory.</p>
    <button type="button" disabled={busy} onClick={() => void generate()} className="min-h-11 rounded-xl bg-p-primary px-4 text-sm font-bold text-white disabled:opacity-60">{busy ? "Готуємо сцени…" : draft ? "Підготувати новий сценарій через OpenAI" : "Підготувати сценарій через OpenAI"}</button>
    {error && <p role="alert" className="rounded-xl border border-p-line p-3 text-sm">{error}</p>}
    {notice && <p role="status" className="text-sm text-p-muted">{notice}</p>}
    {draft && <section aria-label="Готовий сценарій" className="min-w-0 space-y-3 border-t border-p-line pt-4">
      <p className="text-sm font-bold">{draft.scenes.length} сцен · приблизно {Math.ceil(estimatedVideoSeconds(draft) / 60)} хв · OpenAI / {draft.model}</p>
      {draft.sourceHash !== sourceHash && <p role="alert" className="text-sm">Матеріали уроку змінилися після створення цього сценарію. Перевірте його або підготуйте новий.</p>}
      <p className="text-sm text-p-muted">Перевірте факти, озвучення та відповідність візуального ряду перед створенням відео. Інструкція не гарантує, що Pictory виконає всі обмеження.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Формат копіювання">{views.map(view => <button key={view.id} type="button" aria-pressed={mode === view.id} onClick={() => setMode(view.id)} className={`min-h-11 rounded-xl border px-3 text-sm font-bold ${mode === view.id ? "border-p-primary text-p-primary" : "border-p-line"}`}>{view.label}</button>)}</div>
      <p className="text-xs text-p-muted">У поле Pictory «Script to Video» вставляйте «Лише озвучення». Повний промпт і візуальні інструкції використовуйте для налаштування відповідних сцен, щоб диктор не читав технічні вказівки.</p>
      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => void copy()} className="min-h-11 rounded-xl border border-p-line px-4 text-sm font-bold">Скопіювати</button><button type="button" onClick={download} className="min-h-11 rounded-xl border border-p-line px-4 text-sm font-bold">Завантажити TXT</button></div>
      <label className="block text-sm font-bold">{views.find(view => view.id === mode)?.label}
        <textarea readOnly value={text} rows={20} className="mt-2 max-h-[65svh] w-full resize-y rounded-xl border border-p-line bg-p-bg p-3 font-mono text-sm font-normal leading-relaxed" />
      </label>
    </section>}
  </div>;
}
