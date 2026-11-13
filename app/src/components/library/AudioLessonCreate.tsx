"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { audioLessonOptionsAction, createAudioPartAction } from "@/app/actions/audiobooks";
export function AudioLessonCreate({ subjects, subjectId: initialSubject, topicId: initialTopic, lessons: initialLessons }: { subjects: { id: string; name: string }[]; subjectId: string; topicId: string; lessons: { id: string; title: string }[] }) {
  const router = useRouter(); const [subject, setSubject] = useState(initialSubject), [lessons, setLessons] = useState(initialLessons);
  const [topic, setTopic] = useState(initialLessons.some(lesson => lesson.id === initialTopic) ? initialTopic : "");
  const [kind, setKind] = useState<"explanation" | "reading">("explanation");
  const [budget, setBudget] = useState(3), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const submission = useRef<{ key: string; id: string } | null>(null); const load = useRef(0); const locked = useRef(false);
  async function selectSubject(id: string) {
    const version = ++load.current; setSubject(id); setTopic(""); setLessons([]); setMessage("");
    if (!id) return; setBusy(true);
    try { const result = await audioLessonOptionsAction(id); if (version !== load.current) return; if (result.status === "ok") setLessons(result.lessons); else setMessage(result.message); }
    catch { if (version === load.current) setMessage("Не вдалося прочитати готові уроки."); }
    finally { if (version === load.current) setBusy(false); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (locked.current || busy || !consent || !topic) return;
    const lesson = lessons.find(item => item.id === topic); if (!lesson) return;
    locked.current = true; setBusy(true); setMessage("");
    try {
      const request = { materialId: subject, lesson: { kind, subjectId: subject, topicId: topic }, title: `${lesson.title}${kind === "reading" ? " — читання" : ""}`.slice(0, 200), from: 1, to: 1, numbering: "source", budgetUsd: budget, voice: "nova", preserveLines: kind === "reading", retainPrepared: true };
      const key = JSON.stringify(request); if (submission.current?.key !== key) submission.current = { key, id: crypto.randomUUID() };
      const result = await createAudioPartAction({ id: submission.current.id, request });
      if (result.status === "ok") router.push(`/parent/audiobooks/${result.id}`); else setMessage(result.message);
    } catch { setMessage("Не вдалося підтвердити запуск. Перевір аудіопідготовки перед повтором."); }
    finally { locked.current = false; setBusy(false); }
  }
  const input = "mt-2 min-h-12 w-full min-w-0 rounded-xl border border-p-line bg-p-bg p-3 font-normal";
  return <div className="space-y-5"><Link href={subject ? `/parent/subjects/${subject}` : "/parent/library"} className="inline-flex min-h-11 items-center font-bold text-p-primary">← Повернутися</Link><header><h1 className="text-2xl font-bold">Аудіоурок із готового уроку</h1><p className="mt-2 text-p-muted">Використаємо вже підготовлені пояснення, приклади й матеріали. Підручник або його розпізнавання для цього не потрібні.</p></header><form onSubmit={create} className="space-y-4 rounded-2xl border border-p-line bg-p-surface p-5"><label className="block font-bold">Що слухатимемо<select aria-label="Формат аудіо" className={input} value={kind} disabled={busy} onChange={e => setKind(e.target.value as "explanation" | "reading")}><option value="explanation">Пояснення теми — аудіоурок</option><option value="reading">Дослівне читання твору / вірша з уроку</option></select></label><label className="block font-bold">Предмет<select className={input} aria-label="Предмет аудіоуроку" value={subject} disabled={busy} onChange={e => { void selectSubject(e.target.value); }}><option value="">Вибери предмет</option>{subjects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label className="block font-bold">Готовий урок / параграф<select className={input} aria-label="Готовий урок для аудіо" value={topic} disabled={busy || !subject} onChange={e => setTopic(e.target.value)}><option value="">Вибери готовий урок</option>{lessons.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>{subject && !busy && !lessons.length && <p className="text-sm text-p-muted">У цьому предметі поки немає готових уроків. Спочатку підготуй і опублікуй матеріал у Майстерні ШІ.</p>}<p className="text-sm text-p-muted">{kind === "reading" ? "Візьмемо весь наданий текст читання уроку без переказу, скорочення чи редактора ШІ. Якщо в джерелі лише уривок, прочитаємо цей уривок повністю. Ти перевіриш текст перед озвученням." : "Спочатку ШІ підготує зв’язний текст для слухання без екрана. Ти перевіриш його, а потім окремо запустиш озвучення."} Доступ дитині вмикається після твого підтвердження.</p><label className="block font-bold">Ліміт підготовки та озвучення, $<input className={input} type="number" min={0.5} max={25} step={0.5} value={budget} onChange={e => setBudget(Number(e.target.value))} /></label><label className="flex gap-3 text-sm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Погоджую платну підготовку аудіоуроку в межах цього ліміту та збереження матеріалів для власної дитини.</label><button disabled={busy || !consent || !topic} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-p-primary p-3 font-bold text-white disabled:opacity-50">{busy && <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />}{busy ? "Запускаємо підготовку…" : "Підготувати текст аудіоуроку"}</button></form>{message && <p role="status" className="rounded-xl border border-p-line p-3">{message}</p>}</div>;
}
