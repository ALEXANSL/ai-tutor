"use client";
import { useEffect, useRef, useState } from "react";
import { VoiceConversation } from "./VoiceConversation";
import { MathText } from "@/components/shared/MathText";
import type { VoiceTarget, VoiceTurn } from "@/lib/voice";
import { askTopicChatAction } from "@/app/actions/lesson";
import { stopCurrentlyPlaying } from "@/components/shared/singleAudioPlayback";

interface Props { target: VoiceTarget; onActiveChange?: (active: boolean) => void; textChat?: { subjectId: string; topicId: string }; }
export function LessonVoicePanel(props: Props) {
  const identity = props.textChat && props.target.kind === "chapter" ? `chapter:${props.target.lessonId}` : JSON.stringify(props.target);
  return <LessonVoiceSession key={identity} {...props} />;
}
function LessonVoiceSession({ target, onActiveChange, textChat }: Props) {
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
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
      const result = await askTopicChatAction(target.kind === "lesson" ? target.sessionId : null, textChat.subjectId, textChat.topicId, text, target);
      if (!mounted.current) return;
      if (result.status === "ok") {
        setTurns(previous => [...previous, { text, message: result.message, audio: null }]);
        setQuestion("");
      } else setError("Не вдалося надіслати запитання. Текст залишився у полі — спробуй ще раз.");
    } catch {
      if (mounted.current) setError("Не вдалося отримати відповідь. Перевір з’єднання й спробуй ще раз.");
    } finally {
      lock.current = false;
      if (mounted.current) { setPending(false); onActiveChange?.(false); }
    }
  }
  return <div>
    {textChat && <form onSubmit={event => { event.preventDefault(); void send(); }} className="mb-3 min-w-0 rounded-2xl border border-line bg-surface p-3.5">
      <label className="block text-sm font-bold">Запитай репетитора текстом
        <textarea value={question} onFocus={() => { if (!voiceActive) { stopCurrentlyPlaying(); onActiveChange?.(true); } }} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} maxLength={800} rows={3} disabled={pending} placeholder="Напиши або встав запитання з підручника…" className="mt-2 w-full rounded-xl border-2 border-line bg-surface-alt p-3 text-sm font-normal" />
      </label>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><span className="text-xs text-muted">{question.length}/800 · Відповідь з’явиться текстом</span><button type="submit" disabled={pending || voiceActive || !question.trim()} className="min-h-11 rounded-full bg-primary px-4 text-sm font-bold text-white disabled:opacity-60">{pending ? "Готуємо відповідь…" : "Надіслати запитання"}</button></div>
      {voiceActive && <p className="mt-2 text-xs text-muted">Заверши голосову розмову, щоб надіслати текст. Запитання можна підготувати у полі вище.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </form>}
    {turns.length > 0 && <div ref={transcript} className="mb-3 max-h-80 space-y-3 overflow-y-auto rounded-2xl border border-line bg-surface p-3.5" aria-label={textChat ? "Розмова з репетитором" : "Текст голосової розмови"} aria-live="polite">
      {turns.map(turn => <div key={turn.message.id}>
        <p className="mb-1 text-sm"><strong>Ти:</strong> {turn.text}</p>
        <div className="whitespace-pre-wrap break-words text-sm"><strong>Репетитор:</strong> <MathText text={turn.message.content} /></div>
      </div>)}
    </div>}
    <fieldset disabled={pending} className="min-w-0">
      <legend className="sr-only">Голосова розмова</legend>
      <VoiceConversation target={target} onActiveChange={active => { setVoiceActive(active); onActiveChange?.(active); }} onTurn={turn => setTurns(previous => [...previous, turn])} />
    </fieldset>
  </div>;
}
