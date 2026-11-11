"use client";

import { Fragment } from "react";
import { MathText } from "./MathText";

type TextBlock =
  | { kind: "table"; headers: string[]; rows: string[][] }
  | { kind: "code"; text: string }
  | { kind: "paragraph" | "quote"; text: string }
  | { kind: "heading"; text: string; level: number }
  | { kind: "list"; ordered: boolean; items: { text: string; number?: number }[] };

/** Small presentation-only subset: paragraphs, explicit headings, lists and
 * emphasis. HTML, links and embedded instructions stay escaped plain text.
 * Display-math fences keep their original newlines, even across blank lines. */
function tableCells(line: string): string[] {
  return line.trim().replace(/^\\?\|/, "").replace(/\|\s*$/, "").split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
}
const tableSeparator = (line: string) => { const cells = tableCells(line); return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell)); };
export function lessonTextBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: string[] = [];
  let inDisplayMath = false;
  let code: string[] | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  const sourceLines = text.replace(/\r\n/g, "\n").split("\n");
  const inputLines = [...sourceLines];
  for (let lineIndex = 0; lineIndex < inputLines.length; lineIndex++) {
    let line = inputLines[lineIndex]!;
    if (!code && !inDisplayMath && /\|\s*:?-{3,}:?\s*\|/.test(line) && /\|\s+\|/.test(line)) {
      const rows = line.split(/(?<=\|)\s+(?=\|)/);
      inputLines.splice(lineIndex, 1, ...rows); line = rows[0]!;
    }
    if (/^\s*```/.test(line) && !inDisplayMath) {
      if (code) { blocks.push({ kind: "code", text: code.join("\n") }); code = null; }
      else { flush(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const fences = line.match(/\$\$/g)?.length ?? 0;
    if (inDisplayMath || fences) {
      paragraph.push(line);
      if (fences % 2) inDisplayMath = !inDisplayMath;
      continue;
    }
    if (/^\s*\\?\|/.test(line) && inputLines[lineIndex + 1] && tableSeparator(inputLines[lineIndex + 1]!)) {
      const headers = tableCells(line); const rows: string[][] = [];
      let next = lineIndex + 2;
      while (next < inputLines.length && /^\s*\|/.test(inputLines[next]!)) {
        const cells = tableCells(inputLines[next]!);
        if (cells.length !== headers.length) break;
        rows.push(cells); next++;
      }
      if (headers.length === tableCells(inputLines[lineIndex + 1]!).length) {
        flush(); blocks.push({ kind: "table", headers, rows }); lineIndex = next - 1; continue;
      }
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
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
  if (code) blocks.push({ kind: "code", text: code.join("\n") });
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
    if (block.kind === "table") return <div key={index} role="region" aria-label="Навчальна таблиця" tabIndex={0} className="my-4 max-w-full overflow-x-auto rounded-xl border border-line"><table className="w-full border-collapse text-left text-sm"><thead className="bg-surface-alt"><tr>{block.headers.map((header, cell) => <th key={cell} scope="col" className="min-w-32 border-b border-line px-3 py-3 font-extrabold"><InlineText text={header} /></th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex} className="even:bg-surface-alt">{row.map((cell, cellIndex) => <td key={cellIndex} className="border-b border-line px-3 py-3 align-top"><InlineText text={cell} /></td>)}</tr>)}</tbody></table></div>;
    if (block.kind === "code") return <pre key={index} className="max-w-full overflow-x-auto rounded-xl border border-line bg-surface-alt p-4 text-sm"><code>{block.text}</code></pre>;
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
