import type { ExtractedUnit } from "@/server/ingest/text";
const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase("uk").replace(/^\s*(?:§\s*|параграф\s+)?\d+[\s.,:;–—-]*/iu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function headingOffset(text: string, title: string, after = 0): number | null {
  const lines = [...text.matchAll(/[^\n]+/g)]; const wanted = key(title);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.index! < after) continue;
    for (let count = 1; count <= 3; count++) {
      const phrase = lines.slice(i, i + count).map(line => line[0]).join(" ");
      if (key(phrase) === wanted) return lines[i]!.index!;
    }
  }
  const number = /(?:§|параграф)\s*(\d+)/iu.exec(title)?.[1];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; if (line.index! < after) continue;
    if (number && new RegExp(`^\\s*§\\s*${number}(?=\\D|$)`, "u").test(line[0]) && key(lines.slice(i, i + 3).map(item => item[0]).join(" ")).split(" ").some(word => word.length >= 4 && wanted.split(" ").includes(word))) return line.index!;
    for (let count = 1; count <= 3; count++) {
      const phrase = key(lines.slice(i, i + count).map(item => item[0]).join(" "));
      const displayed = lines.slice(i, i + count).map(item => item[0]).join(" ").trim();
      if ((displayed === displayed.toLocaleUpperCase("uk") || /[«“”"]/.test(displayed)) && phrase.length >= 8 && phrase.split(" ").length >= 2 && ` ${wanted} `.includes(` ${phrase} `)) return line.index!;
    }
  }
  return null;
}
export function trimAudioParagraph(units: ExtractedUnit[], title: string, nextTitle?: string): ExtractedUnit[] {
  if (!units.length) throw new Error("Не знайдено сторінок параграфа.");
  const first = units[0]!, last = units.at(-1)!;
  const start = headingOffset(first.text, title);
  if (start === null) throw new Error("Не вдалося надійно визначити початок параграфа. Обери готовий урок для аудіоуроку або перевір текст джерела.");
  const end = nextTitle ? headingOffset(last.text, nextTitle, first === last ? start + 1 : 0) : null;
  if (nextTitle && end === null) throw new Error("Не вдалося відокремити наступний параграф на спільній сторінці. Обери готовий урок для аудіоуроку або уточни джерело.");
  return units.map((unit, index) => ({ ...unit, text: unit.text.slice(index === 0 ? start : 0, index === units.length - 1 && end !== null ? end : undefined) }));
}
/** Reconstruct only the known short suffix/prefix overlap of indexed page chunks. */
export function joinIndexedAudioPage(parts: string[]): string {
  let text = "";
  for (const part of parts) {
    let overlap = 0;
    if (text) for (let length = Math.min(250, text.length, part.length); length >= 80; length--) {
      if (text.endsWith(part.slice(0, length)) && /\s/.test(part[length] ?? "")) { overlap = length; break; }
    }
    text += `${text ? "\n\n" : ""}${part.slice(overlap).trimStart()}`;
  }
  return text;
}
