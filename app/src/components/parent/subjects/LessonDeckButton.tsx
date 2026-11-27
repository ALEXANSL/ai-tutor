"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { makeLessonDeck } from "@/app/actions/narrated-decks";

export interface LessonDeckState { id: string; label: string }

/** One narrated presentation per old lesson: open it if it exists, otherwise
 * make it once (paid: slide plan, pictures and narration). */
export function LessonDeckButton({ subjectId, topicId, title, deck }: { subjectId: string; topicId: string; title: string; deck?: LessonDeckState }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  if (deck) return <Link href={`/parent/studio/presentations/${deck.id}`} className="inline-flex min-h-11 items-center rounded-xl border-2 border-p-primary px-3 font-bold text-p-primary">▶ Презентація · {deck.label}</Link>;
  return <span className="inline-flex flex-col gap-1">
    <button type="button" disabled={pending} aria-label={`Зробити презентацію з озвучкою: ${title}`} title="Слайди з картинками й озвучкою з тексту уроку. Близько $0,50–1 і 5% місячного ліміту озвучки." onClick={() => { setError(""); start(async () => {
      try { const id = await makeLessonDeck(subjectId, topicId); window.location.assign(`/parent/studio/presentations/${id}`); }
      catch (e) { setError(e instanceof Error ? e.message : "Не вдалося почати презентацію."); }
    }); }} className="inline-flex min-h-11 items-center rounded-xl border-2 border-p-primary px-3 font-bold text-p-primary disabled:opacity-60">{pending ? "Ставлю в чергу…" : "🎞 Зробити презентацію"}</button>
    {error && <span role="alert" className="text-xs text-red-700">{error}</span>}
  </span>;
}
