/** Lossless boundaries; each request remains below the TTS provider's character cap. */
export function splitNarrationParts(value: string, max = 3500): string[] {
  const text = value.trim(), parts: string[] = []; let offset = 0;
  if (!Number.isSafeInteger(max) || max < 2) throw new Error("Invalid narration part size");
  while (offset < text.length) {
    let end = Math.min(offset + max, text.length);
    if (end < text.length) {
      const candidate = text.slice(offset, end), stops = [...candidate.matchAll(/[.!?…][\s\n]+|\n\n/g)];
      const last = stops.at(-1); const boundary = last ? offset + last.index! + last[0].length : text.lastIndexOf(" ", end - 1) + 1;
      if (boundary > offset + max / 2) end = boundary;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    parts.push(text.slice(offset, end)); offset = end;
  }
  return parts;
}
