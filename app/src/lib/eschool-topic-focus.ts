import { normalizedSchoolSubject, type SchoolEntry } from "./eschool";
import { leadingParagraphNumber } from "./paragraph-order";
/** Navigation hint only: never persist an inferred lesson binding. */
export function schoolTopicFocus(entry: SchoolEntry, topics: readonly { id: string; title: string }[]): string | null {
  if (entry.topicId) return topics.find(topic => topic.id === entry.topicId)?.id ?? null;
  const title = (value: string) => normalizedSchoolSubject(value.replace(/^\s*(?:§{1,2}\s*|параграф(?:и|ів)?\s+)\d+(?:\s*[–—-]\s*\d+)?[\s.,:;–—-]*/iu, ""));
  const sourceTitle = title(entry.source.topic);
  const exact = sourceTitle ? topics.filter(topic => title(topic.title) === sourceTitle) : [];
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return null;
  const references = [...`${entry.source.topic}\n${entry.source.text}`.matchAll(/(?:§{1,2}\s*|параграф(?:и|ів)?\s+)(\d+)(\s*[–—-]\s*\d+)?/giu)];
  if (references.some(match => match[2])) return null;
  const numbers = new Set(references.map(match => Number(match[1])));
  if (numbers.size !== 1) return null;
  const paragraph = topics.filter(topic => numbers.has(leadingParagraphNumber(topic.title) ?? -1));
  return paragraph.length === 1 ? paragraph[0]!.id : null;
}
