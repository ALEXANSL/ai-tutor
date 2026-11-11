"use client";
import Link from "next/link";
import { homeworkHref } from "@/lib/homework";
import { LibraryReadingLink } from "@/components/library/LibraryReadingLink";
import { useEffect, useRef, useState } from "react";
import { VoiceConversation } from "./VoiceConversation";
import type { VoiceTarget, VoiceTurn } from "@/lib/voice";
import { askTopicChatAction } from "@/app/actions/lesson";
import { stopCurrentlyPlaying } from "@/components/shared/singleAudioPlayback";
import { MAX_LESSON_QUESTION_CHARS, MAX_LESSON_SOURCE_PAGES } from "@/lib/lesson-chat";
import { LessonText } from "@/components/shared/LessonText";

interface Props { target: VoiceTarget; onActiveChange?: (active: boolean) => void; textChat?: { subjectId: string; topicId: string }; sourcePages?: readonly number[]; }
export function LessonVoicePanel(props: Props) {
  const identity = props.textChat && props.target.kind === "chapter" ? `chapter:${props.target.lessonId}` : JSON.stringify(props.target);
  return <LessonVoiceSession key={identity} {...props} />;
}
function LessonVoiceSession({ target, onActiveChange, textChat, sourcePages = [] }: Props) {
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const [selectedPages, setSelectedPages] = useState<number[]>([]);
  const [pageToAdd, setPageToAdd] = useState("");
  const lock = useRef(false);
  const mounted = useRef(true);
  const transcript = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!turns.length || !transcript.current) return;
    transcript.current.scrollTop = transcript.current.scrollHeight;
    transcript.current.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [turns.length]);
  async function send() {
    const text = question.trim();
    if (!textChat || !text || lock.current || voiceActive) return;
    lock.current = true; setPending(true); setError("");
    stopCurrentlyPlaying();
    onActiveChange?.(true); // also interrupt lesson auto-narration while reading the reply
    try {
      const result = selectedPages.length
        ? await askTopicChatAction(target.kind === "lesson" ? target.sessionId : null, textChat.subjectId, textChat.topicId, text, target, { printedPages: selectedPages })
        : await askTopicChatAction(target.kind === "lesson" ? target.sessionId : null, textChat.subjectId, textChat.topicId, text, target);
      if (!mounted.current) return;
      if (result.status === "ok") {
        setTurns(previous => [...previous, { text, message: result.message, audio: null, ...(selectedPages.length ? { sourcePages: [...selectedPages] } : {}) }]);
        setQuestion("");
      } else setError(result.message || "Не вдалося надіслати запитання. Текст залишився у полі — спробуй ще раз.");
    } catch {
      if (mounted.current) setError("Не вдалося отримати відповідь. Перевір з’єднання й спробуй ще раз.");
    } finally {
      lock.current = false;
      if (mounted.current) { setPending(false); onActiveChange?.(false); }
    }
  }
  function addSelection() {
    const selection = window.getSelection()?.toString().trim();
    if (!selection) { setError("Спочатку виділи текст у матеріалі уроку або встав уривок у поле запиту."); return; }
    const next = `${question.trim()}\n\nВиділений уривок для розбору:\n${selection}`.trim();
    if (next.length > MAX_LESSON_QUESTION_CHARS) { setError("Разом із виділеним уривком запит перевищує 20 000 символів. Обери коротший фрагмент."); return; }
    setQuestion(next); setError("");
  }
  return <div>
    {target.kind !== "friend" && <Link href={homeworkHref(target)} onClick={() => { stopCurrentlyPlaying(); onActiveChange?.(true); }} className="mb-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-secondary bg-surface px-4 text-sm font-bold">📝 Домашнє завдання</Link>}
    {textChat && <form onSubmit={event => { event.preventDefault(); void send(); }} className="mb-3 min-w-0 rounded-2xl border border-line bg-surface p-3.5">
      <label className="block text-sm font-bold">Запитай репетитора текстом
        <textarea value={question} onFocus={() => { if (!voiceActive) { stopCurrentlyPlaying(); onActiveChange?.(true); } }} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} maxLength={MAX_LESSON_QUESTION_CHARS} rows={5} disabled={pending} placeholder="Напиши запитання або встав цілу сторінку чи уривок для розбору…" className="mt-2 w-full rounded-xl border-2 border-line bg-surface-alt p-3 text-sm font-normal" />
      </label>
      <button type="button" disabled={pending} onClick={addSelection} className="mt-2 min-h-11 rounded-xl border border-line px-3 text-sm">Додати виділений уривок</button>
      {sourcePages.length > 0 && <div className="mt-3 rounded-xl border border-line p-3">
        <p className="mb-2 text-xs text-muted">Додай до двох PDF-сторінок підручника до текстового запиту. Надішлемо тільки вибрані сторінки; обробка PDF також враховується у витратах ШІ.</p>
        <div className="flex flex-wrap gap-2"><label className="min-w-0 flex-1 text-sm">Сторінка підручника<select aria-label="Сторінка підручника" value={pageToAdd} onChange={event => setPageToAdd(event.target.value)} disabled={pending || selectedPages.length >= MAX_LESSON_SOURCE_PAGES} className="mt-1 min-h-11 w-full rounded-xl border border-line bg-surface-alt px-2"><option value="">Обери сторінку</option>{sourcePages.filter(page => !selectedPages.includes(page)).map(page => <option key={page} value={page}>{page}</option>)}</select></label>
          <button type="button" disabled={pending || !pageToAdd || selectedPages.length >= MAX_LESSON_SOURCE_PAGES} onClick={() => { setSelectedPages(previous => [...previous, Number(pageToAdd)]); setPageToAdd(""); }} className="min-h-11 self-end rounded-xl border border-line px-3 text-sm">Додати сторінку</button></div>
        <div className="mt-2 flex flex-wrap gap-2">{selectedPages.map(page => <button key={page} type="button" disabled={pending} onClick={() => setSelectedPages(previous => previous.filter(value => value !== page))} className="min-h-11 rounded-full border border-secondary px-3 text-sm" aria-label={`Прибрати сторінку ${page}`}>Сторінка {page} ×</button>)}</div>
      </div>}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted">{question.length.toLocaleString("uk")}/20 000 · Відповідь з’явиться текстом</span><button type="submit" disabled={pending || voiceActive || !question.trim()} className="min-h-11 rounded-full bg-primary px-4 text-sm font-bold text-white disabled:opacity-60">{pending ? "Готуємо відповідь…" : "Надіслати запитання"}</button></div>
      {voiceActive && <p className="mt-2 text-xs text-muted">Заверши голосову розмову, щоб надіслати текст. Запитання можна підготувати у полі вище.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </form>}
    {turns.length > 0 && <div ref={transcript} className="mb-3 max-h-80 space-y-3 overflow-y-auto rounded-2xl border border-line bg-surface p-3.5" aria-label={textChat ? "Розмова з репетитором" : "Текст голосової розмови"} aria-live="polite">
      {turns.map(turn => <div key={turn.message.id}>
        {turn.sourcePages?.length ? <p className="mb-1 text-xs text-muted">Додані сторінки: {turn.sourcePages.join(", ")}</p> : null}
        <p className="mb-1 text-sm"><strong>Ти:</strong> {turn.text}</p>
        <div className="break-words text-sm"><strong>Репетитор:</strong><LessonText text={turn.message.content} reflow />{turn.message.libraryLink && <LibraryReadingLink link={turn.message.libraryLink} />}</div>
      </div>)}
    </div>}
    <fieldset disabled={pending} className="min-w-0">
      <legend className="sr-only">Голосова розмова</legend>
      <VoiceConversation target={target} onActiveChange={active => { setVoiceActive(active); onActiveChange?.(active); }} onTurn={turn => setTurns(previous => [...previous, turn])} />
    </fieldset>
  </div>;
}
