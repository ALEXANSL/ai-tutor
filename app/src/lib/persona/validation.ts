/**
 * Nickname and tutor-name validation (US-1.6 KP-1, US-1.7 KP-3, PM-22).
 *
 * Pure and dependency-free: used on the client for instant, friendly hints
 * and re-run on the server before anything is stored. Word lists come from
 * configuration (config/persona-wordlists.json), not from code.
 */

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 20;

export interface PersonaWordlists {
  kinshipWords: readonly string[];
  kinshipPhrases: readonly string[];
  inappropriateWords: readonly string[];
  inappropriateStems: readonly string[];
}

export type NicknameError =
  | "empty"
  | "too_short"
  | "too_long"
  | "at_sign"
  | "long_digits"
  | "link"
  | "invalid_chars";

export type TutorNameError =
  | "empty"
  | "too_short"
  | "too_long"
  | "invalid_chars"
  | "inappropriate"
  | "kinship"
  | "same_as_nickname";

export type ValidationResult<E extends string> =
  | { ok: true; value: string }
  | { ok: false; error: E };

const APOSTROPHES = /['`ʼ‘’]/g;
const CANONICAL_APOSTROPHE = "’";

/** Length in Unicode code points (matches Postgres `char_length`). */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeSpaces(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim();
}

// ---------------------------------------------------------------------------
// Nickname
// ---------------------------------------------------------------------------

const CONTROL_OR_MARKUP = /[\p{Cc}\p{Cf}<>]/u;
const LINK_PATTERN = /(https?:\/\/|www\.|[\p{L}\d-]\.(com|net|org|ua|info|me|io|ru|app|site|online|link)(?![\p{L}\d]))/iu;
/** More than 4 digits in a row, also when split by spaces, dashes, dots or brackets (phone-like). */
const LONG_DIGITS = /\d{5,}/u;
const DIGIT_SEPARATORS = /[\s\-().+_/]/gu;

export function validateNickname(raw: string | null | undefined): ValidationResult<NicknameError> {
  const value = normalizeSpaces(raw ?? "");
  if (value.length === 0) return { ok: false, error: "empty" };
  if (CONTROL_OR_MARKUP.test(value)) return { ok: false, error: "invalid_chars" };
  if (value.includes("@")) return { ok: false, error: "at_sign" };
  if (LINK_PATTERN.test(value)) return { ok: false, error: "link" };
  if (LONG_DIGITS.test(value.replace(DIGIT_SEPARATORS, ""))) return { ok: false, error: "long_digits" };
  const length = codePointLength(value);
  if (length < NAME_MIN_LENGTH) return { ok: false, error: "too_short" };
  if (length > NAME_MAX_LENGTH) return { ok: false, error: "too_long" };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Tutor name
// ---------------------------------------------------------------------------

const UA_LETTERS = "абвгґдеєжзиіїйклмнопрстуфхцчшщьюя";
const LETTER_CLASS = `a-zA-Z${UA_LETTERS}${UA_LETTERS.toUpperCase()}`;
/** Letters (Ukrainian / Latin) separated by single spaces, hyphens or apostrophes. */
const TUTOR_NAME_PATTERN = new RegExp(`^[${LETTER_CLASS}]+(?:[ \\-${CANONICAL_APOSTROPHE}][${LETTER_CLASS}]+)*$`, "u");

/** Latin letters that look like Cyrillic ones — folded so "mаmа" cannot slip through. */
const LOOKALIKE_TO_CYRILLIC: Record<string, string> = {
  a: "а", b: "в", c: "с", e: "е", h: "н", i: "і", k: "к", m: "м",
  o: "о", p: "р", t: "т", x: "х", y: "у",
};

function foldForMatching(value: string): string {
  return value.toLowerCase().replace(APOSTROPHES, "").replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

function foldLookalikes(value: string): string {
  return Array.from(value)
    .map((ch) => LOOKALIKE_TO_CYRILLIC[ch] ?? ch)
    .join("");
}

function matchVariants(value: string): string[] {
  const folded = foldForMatching(value);
  const cyr = foldLookalikes(folded);
  return cyr === folded ? [folded] : [folded, cyr];
}

function containsWord(variants: string[], words: readonly string[]): boolean {
  const normalizedWords = new Set(words.map(foldForMatching));
  return variants.some((variant) => variant.split(" ").some((token) => normalizedWords.has(token)));
}

function containsStem(variants: string[], stems: readonly string[]): boolean {
  const normalizedStems = stems.map(foldForMatching).filter((s) => s.length > 0);
  return variants.some((variant) =>
    variant.split(" ").some((token) => normalizedStems.some((stem) => token.startsWith(stem))),
  );
}

function containsPhrase(variants: string[], phrases: readonly string[]): boolean {
  const normalizedPhrases = phrases.map(foldForMatching).filter((p) => p.length > 0);
  return variants.some((variant) => normalizedPhrases.some((phrase) => ` ${variant} `.includes(` ${phrase} `)));
}

export function normalizeTutorName(raw: string | null | undefined): string {
  return normalizeSpaces(raw ?? "").replace(APOSTROPHES, CANONICAL_APOSTROPHE);
}

/** Case/spacing/apostrophe-insensitive comparison key (e.g. name vs nickname). */
export function comparisonKey(value: string): string {
  return foldForMatching(normalizeSpaces(value)).replace(/\s+/g, "");
}

export function validateTutorName(
  raw: string | null | undefined,
  options: { nickname?: string | null; wordlists: PersonaWordlists },
): ValidationResult<TutorNameError> {
  const value = normalizeTutorName(raw);
  if (value.length === 0) return { ok: false, error: "empty" };
  const length = codePointLength(value);
  if (length < NAME_MIN_LENGTH) return { ok: false, error: "too_short" };
  if (length > NAME_MAX_LENGTH) return { ok: false, error: "too_long" };
  if (!TUTOR_NAME_PATTERN.test(value)) return { ok: false, error: "invalid_chars" };

  const variants = matchVariants(value);
  const { wordlists } = options;
  if (containsWord(variants, wordlists.inappropriateWords) || containsStem(variants, wordlists.inappropriateStems)) {
    return { ok: false, error: "inappropriate" };
  }
  if (containsWord(variants, wordlists.kinshipWords) || containsPhrase(variants, wordlists.kinshipPhrases)) {
    return { ok: false, error: "kinship" };
  }
  if (options.nickname && comparisonKey(options.nickname) === comparisonKey(value)) {
    return { ok: false, error: "same_as_nickname" };
  }
  return { ok: true, value };
}
