import type { StudioLesson } from "./studio";

/** Model-facing author contract; runtime narration is materialized only in storage/playback. */
export function studioModelLesson(lesson: StudioLesson) {
  return { ...lesson, blocks: lesson.blocks.map(block => ({ ...block, narration: usesGeneratedStudioNarration(block) ? null : block.narration })) };
}
function usesGeneratedStudioNarration(block: { kind: string; narrationLanguage?: string | null }) {
  return block.kind !== "code" && (!block.narrationLanguage || block.narrationLanguage === "uk-UA");
}

/** Same learning content on screen and in speech; strip presentation syntax, never summarise. */
export function studioNarrationText(block: { kind: string; text: string; narration?: string | null; narrationLanguage?: string | null }): string {
  if (!usesGeneratedStudioNarration(block)) return (block.narration ?? "").trim();
  const lines = block.text.split("\n"), spoken: string[] = [];
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map(value => value.trim());
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] ?? "")) {
      const headers = cells(lines[index]!); index += 2;
      for (; index < lines.length && lines[index]!.includes("|"); index++) spoken.push(cells(lines[index]!).map((cell, i) => `${headers[i] ?? "Значення"}: ${cell}`).join(". ") + ".");
      index--; continue;
    }
    spoken.push(lines[index]!);
  }
  return spoken.join("\n").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*>\s?/gm, "").replace(/^\s*[-*+]\s+/gm, "").replace(/\*\*|__|`/g, "").trim();
}
