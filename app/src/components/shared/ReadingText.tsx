"use client";

import { useState } from "react";
import { hasReadingExtractionArtifacts } from "@/lib/reading-presentation";
import { LessonText } from "./LessonText";

/** Reflow whitespace visually, leaving the stored text and TTS unchanged. */
export function ReadingText({ text, initialLayout = "paragraphs" }: { text: string; initialLayout?: "paragraphs" | "lines" }) {
  const [layout, setLayout] = useState(initialLayout);
  return <>
    <div className="reading-layout" role="group" aria-label="Вигляд тексту">
      <span>Вигляд тексту</span>
      <button type="button" aria-pressed={layout === "paragraphs"} onClick={() => setLayout("paragraphs")}>Абзаци</button>
      <button type="button" aria-pressed={layout === "lines"} onClick={() => setLayout("lines")}>Рядки оригіналу</button>
    </div>
    {hasReadingExtractionArtifacts(text) && <details className="reading-source-note"><summary>Можливі помилки розпізнавання</summary><p>Звір незрозумілий фрагмент зі сторінкою підручника. Порядок слів і помилкові літери потрібно виправляти за джерелом.</p></details>}
    <LessonText text={text} preserveLines={layout === "lines"} reflow={layout === "paragraphs"} />
  </>;
}
