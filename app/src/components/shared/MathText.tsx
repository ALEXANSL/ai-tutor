"use client";

import katex from "katex";
import { Fragment, useMemo } from "react";

/**
 * 2026-10-02: real LaTeX rendering for any text that mixes plain Ukrainian
 * prose with inline `$...$`/display `$$...$$` math — the exact shape every
 * course-package field uses (`teacher_notes_md`, `prompt_md`, `question`,
 * option/answer text, `explanation_md`). Before this, the raw `$...$`/
 * `\frac{}{}` source was shown verbatim to the child ("Обчисли
 * $2-\frac12:\frac14$." — unreadable). KaTeX is already MIT-licensed and
 * the course package itself vendors it for its own offline preview.html —
 * this is the same library, just wired into the actual app instead.
 *
 * Deliberately NOT a full Markdown renderer (no headings/bold/lists parsed)
 * — every field this is used on is one line or a short paragraph of prose
 * plus math, never full Markdown structure; adding a Markdown parser on
 * top would be scope this slice doesn't need.
 */

const MATH_SPLIT_RE = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$)/g;

function renderSegment(segment: string, key: number) {
  if (segment.startsWith("$$") && segment.endsWith("$$")) {
    const tex = segment.slice(2, -2);
    return <DisplayMath key={key} tex={tex} />;
  }
  if (segment.startsWith("$") && segment.endsWith("$") && segment.length > 1) {
    const tex = segment.slice(1, -1);
    return <InlineMath key={key} tex={tex} />;
  }
  return <Fragment key={key}>{segment}</Fragment>;
}

function InlineMath({ tex }: { tex: string }) {
  const html = useMemo(() => renderTexSafe(tex, false), [tex]);
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

function DisplayMath({ tex }: { tex: string }) {
  const html = useMemo(() => renderTexSafe(tex, true), [tex]);
  return <div className="math-display" dangerouslySetInnerHTML={{ __html: html }} />;
}

function renderTexSafe(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode, throwOnError: false, output: "html" });
  } catch {
    // A malformed formula must never blank the whole question — fall back
    // to the raw source wrapped in a visibly-monospace span rather than
    // crashing the component tree.
    return `<span class="math-fallback">${tex.replace(/</g, "&lt;")}</span>`;
  }
}

/** Renders `text` with every `$...$`/`$$...$$` segment as real math, everything else as plain text. */
export function MathText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => text.split(MATH_SPLIT_RE), [text]);
  return <span className={className}>{parts.map((part, i) => renderSegment(part, i))}</span>;
}
