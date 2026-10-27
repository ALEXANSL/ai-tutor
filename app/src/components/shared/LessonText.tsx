"use client";

import { Fragment } from "react";
import { MathText } from "./MathText";

type TextBlock =
  | { kind: "paragraph" | "quote"; text: string }
  | { kind: "heading"; text: string; level: number }
  | { kind: "list"; ordered: boolean; items: { text: string; number?: number }[] };

/** Small presentation-only subset: paragraphs, explicit headings, lists and
 * emphasis. HTML, links and embedded instructions stay escaped plain text.
 * Display-math fences keep their original newlines, even across blank lines. */
export function lessonTextBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: string[] = [];
  let inDisplayMath = false;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fences = line.match(/\$\$/g)?.length ?? 0;
    if (inDisplayMath || fences) {
      paragraph.push(line);
      if (fences % 2) inDisplayMath = !inDisplayMath;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: Math.min(6, heading[1]!.length + 3), text: heading[2]! });
      continue;
    }
    const ordered = /^\s*(\d{1,4})[.)]\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ordered || bullet) {
      flush();
      const item = ordered ? { number: Number(ordered[1]), text: ordered[2]! } : { text: bullet![1]! };
      const previous = blocks.at(-1);
      if (previous?.kind === "list" && previous.ordered === !!ordered) previous.items.push(item);
      else blocks.push({ kind: "list", ordered: !!ordered, items: [item] });
      continue;
    }
    const quote = /^>\s?(.+)$/.exec(line);
    if (quote) {
      flush();
      const previous = blocks.at(-1);
      if (previous?.kind === "quote") previous.text += `\n${quote[1]}`;
      else blocks.push({ kind: "quote", text: quote[1]! });
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

function InlineText({ text }: { text: string }) {
  // Match complete math first: ** inside LaTeX must not become emphasis.
  return <>{text.split(/(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\*\*[^*\n]+?\*\*)/g).map((part, index) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={index}><MathText text={part.slice(2, -2)} /></strong>
      : <Fragment key={index}><MathText text={part} /></Fragment>,
  )}</>;
}

export function LessonText({ text, preserveLines = false, reflow = false }: { text: string; preserveLines?: boolean; reflow?: boolean }) {
  if (preserveLines) return <div className="lesson-prose lesson-prose--reading"><div className="lesson-prose__paragraph"><MathText text={text} /></div></div>;
  return <div className={`lesson-prose${reflow ? " lesson-prose--reflow" : ""}`}>{lessonTextBlocks(text).map((block, index) => {
    if (block.kind === "heading") {
      const Heading = `h${block.level}` as "h4" | "h5" | "h6";
      return <Heading key={index}><InlineText text={block.text} /></Heading>;
    }
    if (block.kind === "list") {
      const items = block.items.map((item, itemIndex) => <li key={itemIndex} value={item.number}><InlineText text={item.text} /></li>);
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    if (block.kind === "quote") return <blockquote key={index}><InlineText text={block.text} /></blockquote>;
    return <div key={index} className="lesson-prose__paragraph"><InlineText text={block.text} /></div>;
  })}</div>;
}
