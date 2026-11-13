"use client";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { reviseImportedLessonAction } from "@/app/actions/studio";
import { parentButton, parentInput } from "@/app/parent/ui";
import { withBusySignal } from "@/lib/busy-signal";
export function ReviseLessonsDialog({ subjectId, topics, onClose }: { subjectId: string; topics: { id: string; title: string }[]; onClose: () => void }) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null); const lock = useRef(false); const submission = useRef<{ key: string; ids: Map<string, string> } | null>(null);
  const [instructions, setInstructions] = useState("Перероби урок як повноцінне заняття з репетитором: спочатку зрозуміле пояснення теми й навчальний матеріал, розібрані приклади, а потім практика та запитання. Використай вже наявні джерела й доповни перевірними знаннями. Не обмежуйся переліком запитань.");
  const [age, setAge] = useState(12); const [grade, setGrade] = useState(6); const [budget, setBudget] = useState(3); const [pending, setPending] = useState(false);
  const [results, setResults] = useState<Record<string, { id?: string; error?: string; message?: string }>>({}); const [done, setDone] = useState(0);
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  async function submit() {
    if (lock.current) return; lock.current = true; setPending(true); setDone(0);
    const key = JSON.stringify({ subjectId, topics: topics.map(item => item.id), instructions, age, grade, budget });
    if (submission.current?.key !== key) submission.current = { key, ids: new Map(topics.map(item => [item.id, crypto.randomUUID()])) };
    try { await withBusySignal(async () => {
      for (let index = 0; index < topics.length; index++) {
        const topic = topics[index]!;
        try {
          const response = await reviseImportedLessonAction({ subjectId, topicId: topic.id, requestId: submission.current!.ids.get(topic.id)!, instructions, age, grade, budgetUsd: budget });
          setResults(previous => ({ ...previous, [topic.id]: response.status === "ok" ? { id: response.id, message: response.message } : { error: response.message } }));
        } catch { setResults(previous => ({ ...previous, [topic.id]: { error: "Запит не підтверджено. Перевір Майстерню перед повтором; підготовка могла вже початися." } })); }
        setDone(index + 1);
      }
    }); } finally { lock.current = false; setPending(false); }
  }
  return <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { if (pending) event.preventDefault(); else onClose(); }} className="m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-p-line bg-p-surface p-5 text-p-text backdrop:bg-black/60"><form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-4"><header className="flex items-start justify-between gap-3"><h2 id={titleId} className="text-xl font-bold">Переробити {topics.length === 1 ? "урок" : `уроки: ${topics.length}`}</h2><button type="button" aria-label="Закрити діалог переробки" disabled={pending} onClick={onClose} className="min-h-11 min-w-11 rounded-xl border border-p-line">✕</button></header><p className="text-sm text-p-muted">Наявні уроки залишаються доступними. Для кожного створюється окрема чернетка в Майстерні; після рецензії й твого перегляду опублікуєш нову версію. Вимкнення нової версії повертає оригінал. Повторний ZIP не потрібний.</p><ul className="list-disc pl-5 text-sm">{topics.map(topic => <li key={topic.id}>{topic.title}</li>)}</ul><fieldset disabled={pending} className="space-y-4"><label className="block text-sm font-bold">Що потрібно переробити?<textarea aria-label="Побажання до переробки уроків" required minLength={10} maxLength={3000} value={instructions} onChange={event => setInstructions(event.target.value)} rows={6} className={`${parentInput} mt-2 py-3 font-normal`} /></label><div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><label className="text-sm">Вік<input aria-label="Вік для переробки" type="number" min={7} max={18} value={age} onChange={event => setAge(Number(event.target.value))} className={`${parentInput} mt-1`} /></label><label className="text-sm">Клас<input aria-label="Клас для переробки" type="number" min={1} max={12} value={grade} onChange={event => setGrade(Number(event.target.value))} className={`${parentInput} mt-1`} /></label><label className="text-sm">Ліміт на один урок, $<input type="number" min={0.5} max={25} step={0.5} value={budget} onChange={event => setBudget(Number(event.target.value))} className={`${parentInput} mt-1`} /></label></div><p className="text-xs text-p-muted">До ${Number.isFinite(budget) ? (budget * topics.length).toFixed(2) : "—"} на всі вибрані уроки. Спочатку платна підготовка плану; повний урок — після погодження плану в Майстерні. Для вже створеної версії запуститься її доопрацювання.</p><button type="submit" className={parentButton}>{pending ? `Зберігаємо запити: ${done}/${topics.length}` : "Підготувати нові версії"}</button></fieldset>{pending && <p role="status" className="text-sm">Запити зберігаються. Подальша підготовка має власний прогрес у кожній чернетці.</p>}<ul className="space-y-2">{topics.map(topic => results[topic.id] && <li key={topic.id} className="rounded-xl border border-p-line p-3 text-sm"><strong>{topic.title}</strong>{results[topic.id]!.id ? <><p className="mt-1 text-p-muted">{results[topic.id]!.message}</p><Link href={`/parent/studio/${results[topic.id]!.id}`} className="mt-1 inline-flex min-h-11 items-center font-bold text-p-primary">Відкрити чернетку →</Link></> : <p role="alert" className="mt-1 text-p-danger">{results[topic.id]!.error}</p>}</li>)}</ul></form></dialog>;
}
