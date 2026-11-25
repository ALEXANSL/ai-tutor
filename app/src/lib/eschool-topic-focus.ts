import { normalizedSchoolSubject, type SchoolEntry } from "./eschool";
import { leadingParagraphNumber } from "./paragraph-order";

type Topic = { id: string; title: string; pageFrom?: number | null; pageTo?: number | null };
const MAX_MATCHES = 6;
const withoutParagraph = (value: string) => value.replace(/^\s*(?:§{1,2}\s*|параграф(?:и|ів)?\s+)\d+(?:\s*[–—-]\s*\d+)?[\s.,:;–—-]*/iu, "");
const titleKey = (value: string) => normalizedSchoolSubject(withoutParagraph(value).normalize("NFKC"));
const containsPhrase = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `);
const ignored = new Set("урок тема теми частина частини коротко письменник письменника поет поета життя творчість творчості читання прочитати опрацювати підручник підручника сторінка сторінки запитання відповіді завдання робота роботи повторення узагальнення знань матеріал матеріалу пояснення пояснити вивчення основні основних розвиток продовження".split(" "));

function words(value: string): Set<string> {
  return new Set(titleKey(value).split(" ").filter(word => word.length >= 4 && !ignored.has(word) && !/^\d+$/.test(word)).map(word => {
    // Inflection only; a shared short root alone is never enough evidence.
    const root = word.replace(/(?:ього|ого|ому|ими|ами|ями|ові|еві|ою|ею|ів|ах|ях|их|ім|им|ий|ій|а|я|и|і|у|ю|о|е|є)$/u, "");
    return root.length >= 4 ? root : word;
  }));
}
function quotedWorks(value: string): string[] {
  return [...new Set([...value.matchAll(/[«“„"]([^»”“"\n]{2,180})[»”“"]/gu)].map(match => titleKey(match[1]!)).filter(work => work.length >= 5))];
}
function sameWork(a: string, b: string): boolean {
  const key = (value: string) => value.split(" ").filter(word => !["у", "в", "з", "із", "і", "й", "та"].includes(word)).join(" ");
  const left = key(a), right = key(b);
  return left === right || (Math.min(left.split(" ").length, right.split(" ").length) >= 2 && (containsPhrase(left, right) || containsPhrase(right, left)));
}
function author(value: string): string | null {
  const match = /^\s*([\p{Lu}][\p{L}’ʼ'-]+)\s+([\p{Lu}][\p{L}’ʼ'-]+)\s*[.,:;–—-]*\s*[«“„"]/u.exec(withoutParagraph(value));
  return match ? [...words(`${match[1]} ${match[2]}`)].join(" ") : null;
}
function uniqueBest(scores: { id: string; score: number }[], margin: number): string | null {
  scores.sort((a, b) => b.score - a.score);
  return scores[0] && (!scores[1] || scores[0].score - scores[1].score >= margin) ? scores[0].id : null;
}

/** Navigation hint only: the single owned visible topic, or null when none/several fit. */
export function schoolTopicFocus(entry: SchoolEntry, topics: readonly Topic[]): string | null {
  const matches = schoolTopicMatches(entry, topics);
  return matches.length === 1 ? matches[0]! : null;
}

/** Printed textbook pages named by the teacher ("с. 93–99", "стор. 86"), as inclusive ranges. */
export function schoolPageRanges(value: string): [number, number][] {
  return [...value.matchAll(/(?<!\p{L})(?:стор(?:інк(?:а|и|і|ах)?)?\.?|ст\.|с\.)\s*(\d{1,3})(?:\s*[–—-]\s*(\d{1,3}))?/giu)]
    .map(match => { const from = Number(match[1]); const to = match[2] ? Number(match[2]) : from; return [Math.min(from, to), Math.max(from, to)] as [number, number]; })
    .filter(([from, to]) => from > 0 && to - from <= 60);
}

/**
 * All ready topics that cover the teacher's diary topic: one lesson, or several
 * when a work/paragraph range is split across lessons. Deterministic and free.
 */
export function schoolTopicMatches(entry: SchoolEntry, topics: readonly Topic[]): string[] {
  if (entry.topicId) return topics.filter(topic => topic.id === entry.topicId).map(topic => topic.id);
  const sourceTitle = titleKey(entry.source.topic);
  const exact = sourceTitle ? topics.filter(topic => titleKey(topic.title) === sourceTitle) : [];
  if (exact.length) return exact.length === 1 ? [exact[0]!.id] : [];

  const references = [...`${entry.source.topic}\n${entry.source.text}`.matchAll(/(?:§{1,2}\s*|параграф(?:и|ів)?\s+)(\d+)(?:\s*[–—-]\s*(\d+))?/giu)];
  if (references.length) {
    const numbers = new Set<number>();
    for (const match of references) { const from = Number(match[1]), to = match[2] ? Number(match[2]) : from; for (let n = Math.min(from, to); n <= Math.max(from, to) && n - from < 10; n++) numbers.add(n); }
    const result: string[] = [];
    for (const number of numbers) {
      const paragraph = topics.filter(topic => leadingParagraphNumber(topic.title) === number);
      // Two textbooks with the same § number: refuse to guess.
      if (paragraph.length > 1) return [];
      if (paragraph[0]) result.push(paragraph[0].id);
    }
    return result.length <= MAX_MATCHES ? result : [];
  }

  // The teacher's topic is primary evidence. Homework may name several other works.
  const source = entry.source.topic.trim() || entry.source.text;
  const sourceKey = titleKey(source);
  const works = quotedWorks(source);
  const sourceAuthor = author(source);
  const candidates = topics.map(topic => ({ ...topic, key: titleKey(topic.title), works: quotedWorks(topic.title), author: author(topic.title), words: words(topic.title) }));
  const compatible = candidates.filter(candidate => {
    if (sourceAuthor && candidate.author && sourceAuthor !== candidate.author) return false;
    return !works.length || !candidate.works.length || candidate.works.every(work => works.some(sourceWork => sameWork(sourceWork, work)));
  });
  const named = compatible.filter(candidate => works.some(work => candidate.works.length ? candidate.works.some(candidateWork => sameWork(candidateWork, work)) : sameWork(candidate.key, work)));
  if (named.length) {
    const authors = new Set(named.flatMap(candidate => candidate.author ? [candidate.author] : []));
    // Several lessons about the same work (parts, different angles) all cover the topic.
    if (named.length > 1 && authors.size <= 1 && works.length === 1 && named.length <= MAX_MATCHES) return narrowByPages(entry, named).map(candidate => candidate.id);
    // Work title + explicit matching author outranks a title with no author.
    const best = uniqueBest(named.map(candidate => ({ id: candidate.id, score: sourceAuthor && candidate.author === sourceAuthor ? 2 : 1 })), 0.5);
    return best ? [best] : [];
  }

  // Same textbook: overlapping printed pages show which lessons cover the task.
  const paged = pageMatches(entry, topics);
  if (paged.length) return paged.map(topic => topic.id);
  // An explicitly named work must not turn into a different work by word overlap.
  if (works.length) return [];

  const sourceWords = words(source);
  if (sourceWords.size < 3) return [];
  const frequency = new Map<string, number>();
  for (const candidate of candidates) for (const word of candidate.words) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  const weight = (word: string) => 1 + Math.log((candidates.length + 1) / ((frequency.get(word) ?? 0) + 1));
  const scores: { id: string; score: number }[] = [];
  for (const candidate of compatible) {
    const common = [...candidate.words].filter(word => sourceWords.has(word));
    if (common.length < 3) continue;
    const coverage = common.reduce((sum, word) => sum + weight(word), 0) / [...candidate.words].reduce((sum, word) => sum + weight(word), 0);
    const sourceCoverage = common.length / sourceWords.size;
    const phrase = containsPhrase(sourceKey, candidate.key);
    if (coverage >= 0.8 && (sourceCoverage >= 0.3 || phrase)) scores.push({ id: candidate.id, score: coverage * 0.8 + Math.min(1, sourceCoverage) * 0.2 });
  }
  const best = uniqueBest(scores, 0.12);
  return best ? [best] : [];
}

function pageMatches<T extends Topic>(entry: SchoolEntry, topics: readonly T[]): T[] {
  const ranges = schoolPageRanges(`${entry.source.topic}\n${entry.source.text}`);
  if (!ranges.length) return [];
  const hits = topics.filter(topic => topic.pageFrom != null && topic.pageTo != null && ranges.some(([from, to]) => topic.pageFrom! <= to && topic.pageTo! >= from));
  // Too many overlapping lessons means the reference is too broad to be useful.
  return hits.length <= 4 ? hits : [];
}
function narrowByPages<T extends Topic>(entry: SchoolEntry, topics: readonly T[]): T[] {
  const paged = pageMatches(entry, topics);
  return paged.length ? paged : [...topics];
}
