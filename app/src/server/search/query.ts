/**
 * Text part of the hybrid search (ADR-008). Postgres has no Ukrainian stemmer,
 * so every word becomes a PREFIX term of its beginning: "дроби" → "дроб:*"
 * matches "дроби", "дробів", "дробами". Forms with a changed stem ("дріб")
 * are covered by the vector search and by trigram similarity in SQL.
 */
const MIN_WORD = 3;
const MAX_TERMS = 8;

/** Very small Ukrainian/English stop list: words that only add noise. */
const STOP = new Set(["і", "й", "та", "або", "в", "у", "на", "з", "із", "зі", "до", "про", "що", "як", "це", "для", "the", "and", "of"]);

export function prefixStem(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 4) return w;
  // Cut a typical inflection ending (1–2 letters), keep at least 4 letters.
  const cut = w.length >= 7 ? 2 : 1;
  return w.slice(0, Math.max(4, w.length - cut));
}

/** Builds a safe `to_tsquery('simple', …)` string, or null when nothing searchable remains. */
export function buildTsQuery(query: string): string | null {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= MIN_WORD && !STOP.has(w));
  const terms = [...new Set(words.map(prefixStem))].slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  // Only letters/digits reach the query (no tsquery syntax injection).
  return terms.map((t) => `${t}:*`).join(" | ");
}

export function cleanQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().slice(0, 200);
}
