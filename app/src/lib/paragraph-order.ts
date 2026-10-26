/** Explicit textbook paragraph prefixes only; never treat dates or task
 * numbers buried in a title as curriculum order. */
export function leadingParagraphNumber(title: string): number | null {
  const match = /^\s*(?:§{1,2}\s*|параграф(?:и|ів)?\s+)(\d+)(?=$|[\s.,:;–—-])/iu.exec(title);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) ? number : null;
}

/** Sort only numbered slots; preserve introductions/reviews and stable ties.
 * Reads repair old imports without rewriting IDs, progress or stored order. */
export function orderParagraphs<T>(items: readonly T[], title: (item: T) => string, eligible: (item: T) => boolean = () => true): T[] {
  const entries = items.map((item, index) => ({ item, index, number: eligible(item) ? leadingParagraphNumber(title(item)) : null }));
  const numbered = entries.filter(entry => entry.number !== null).sort((a, b) => a.number! - b.number! || a.index - b.index);
  let cursor = 0;
  return entries.map(entry => entry.number === null ? entry.item : numbered[cursor++]!.item);
}
