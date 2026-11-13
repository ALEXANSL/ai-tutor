import { normalizedSchoolSubject, type SchoolEntry } from "./eschool";
import { leadingParagraphNumber } from "./paragraph-order";

type Topic = { id: string; title: string };
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

/** Navigation hint only: owned visible candidates, no model call or saved inferred binding. */
export function schoolTopicFocus(entry: SchoolEntry, topics: readonly Topic[]): string | null {
  if (entry.topicId) return topics.find(topic => topic.id === entry.topicId)?.id ?? null;
  const sourceTitle = titleKey(entry.source.topic);
  const exact = sourceTitle ? topics.filter(topic => titleKey(topic.title) === sourceTitle) : [];
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return null;

  const references = [...`${entry.source.topic}\n${entry.source.text}`.matchAll(/(?:§{1,2}\s*|параграф(?:и|ів)?\s+)(\d+)(\s*[–—-]\s*\d+)?/giu)];
  if (references.length) {
    if (references.some(match => match[2])) return null;
    const numbers = new Set(references.map(match => Number(match[1])));
    if (numbers.size !== 1) return null;
    const paragraph = topics.filter(topic => numbers.has(leadingParagraphNumber(topic.title) ?? -1));
    return paragraph.length === 1 ? paragraph[0]!.id : null;
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
    // Work title + explicit matching author outranks a title with no author.
    return uniqueBest(named.map(candidate => ({ id: candidate.id, score: sourceAuthor && candidate.author === sourceAuthor ? 2 : 1 })), 0.5);
  }
  // An explicitly named work must not turn into a different work by word overlap.
  if (works.length) return null;

  const sourceWords = words(source);
  if (sourceWords.size < 3) return null;
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
  return uniqueBest(scores, 0.12);
}
