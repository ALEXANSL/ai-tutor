import "server-only";
import type { GeneratedStep, LessonBlockGenerated } from "./schema";

/**
 * ADR-034: the `content_qa` technical QA gate — deterministic, $0 (no AI
 * call), rule-based checks run BEFORE the paid `lesson_review` role. It
 * generalizes today's `truncateAtSentenceBoundary` fix (`ingest/text.ts`,
 * commit 97cc8bb, BUG-011) into a final safeguard applied to every text
 * field of every step, plus two new checks (encoding sanity, verbatim
 * fidelity) directly requested by the PO after BUG-011 (mid-sentence
 * truncation) and BUG-046 (CP1251→Latin-1 mojibake) both shipped undetected
 * — neither is a *pedagogical* defect, so `lesson_review`'s own rubric
 * (methodology/safety/age-fit) was never going to catch either one.
 *
 * All three checks are pure string computations — no network call, no
 * model, no `ai_calls` cost — exactly the same class of guard as the
 * existing `verifyProblemNumbers` (ADR-029 §1, `pipeline.ts`).
 */

export type ContentFieldKind = "prose" | "label";

export type ContentQaFailureCode = "completeness" | "encoding" | "fidelity";

export interface ContentQaFailure {
  /** 0-based index of the step this field belongs to (fidelity checks on a
   * standalone excerpt, not a step array, use 0). */
  stepIndex: number;
  /** Dotted/bracketed path within the step, e.g. `options[1].textUk`. */
  field: string;
  code: ContentQaFailureCode;
  /** Ukrainian, human-readable — shown to the parent / fed back into `revisionNotes`. */
  reason: string;
}

export interface ContentQaResult {
  ok: boolean;
  failures: ContentQaFailure[];
}

// ---------------------------------------------------------------------------
// 1. Completeness (`looksComplete`) — generalizes the sentence-boundary
//    heuristic already proven in `truncateAtSentenceBoundary` into a final
//    check over *already-produced* text (both the AI generation path, which
//    `truncateAtSentenceBoundary` never touches, and the verbatim excerpt
//    path, which it does).
// ---------------------------------------------------------------------------

/**
 * Short Ukrainian conjunctions/prepositions that cannot legitimately end a
 * finished sentence or phrase — a text ending on one of these is, by
 * construction, cut off before its continuation. Intentionally short and
 * unambiguous (conservative: minimizes false positives per ADR-034, not an
 * exhaustive grammar).
 */
const UK_DANGLING_WORDS = new Set([
  "і", "й", "та", "а", "але", "або", "що", "як", "у", "в", "на", "з", "із", "зі", "зо",
  "до", "від", "для", "це", "чи", "би", "б", "же", "ж", "не", "ні", "то", "щоб",
  "коли", "бо", "аби", "хоча", "при", "про", "над", "під", "за", "по", "між",
  "серед", "через", "отже", "тобто", "адже", "мов", "ніби", "якщо", "лише", "тільки",
]);

function lastToken(text: string): string {
  const m = /(\S+)\s*$/.exec(text.trim());
  return m ? m[1]! : "";
}

/** Strips wrapping quotes/brackets and trailing sentence punctuation, for the stop-word lookup only. */
function coreWord(token: string): string {
  return token
    .replace(/^[("«‘'“]+/u, "")
    .replace(/[.,!?…:;"»”’')\]]+$/u, "")
    .toLowerCase();
}

/**
 * `kind: "prose"` (explanations/questions/sentences) rejects text that:
 *   a) ends on a short conjunction/preposition (the thought obviously continues),
 *   b) ends on a comma or dash with no terminal punctuation after it, or
 *   c) ends on a "word" that has digits but no letters at all — a number or
 *      code cut mid-way (e.g. "...досягнуто 70" instead of "...70 балів").
 * `kind: "label"` (short captions/options/step titles) only rejects (a) and
 * (c) — a label is not expected to end in sentence punctuation.
 */
export function looksComplete(text: string, kind: ContentFieldKind = "prose"): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true; // zod's `.min(1)` already guards true emptiness upstream

  const rawLast = lastToken(trimmed);
  if (!rawLast) return true;

  // c) (prose only — a short numeric/fraction label like "1/2" or "42" is a
  // perfectly normal, complete label, not a truncation) a digits-only
  // fragment with no letters at all and no real terminator — a number or
  // code cut mid-way ("...досягнуто 70" instead of "...70 балів").
  if (kind === "prose" && /\d/.test(rawLast) && !/\p{L}/u.test(rawLast) && !/[.!?…%)]$/u.test(rawLast)) return false;

  // a) dangling conjunction/preposition — mid-PROSE cutoff signal only. A
  // `label` field that consists of exactly one word (the whole trimmed text
  // *is* that one token, e.g. a "Так"/"Ні" choice-option text, or a
  // one-word "За"/"До" answer) has no preceding context within the same
  // field to be "continuing" — it is a complete answer by construction, not
  // a truncated phrase, so the list only applies when there's more than one
  // word to have been cut off from, or the field is prose (BUG-047).
  const word = coreWord(rawLast);
  const isSingleWordLabel = kind === "label" && rawLast === trimmed;
  if (!isSingleWordLabel && UK_DANGLING_WORDS.has(word)) return false;

  // b) prose only: ends on a bare comma or dash.
  if (kind === "prose" && /[,—–-]$/u.test(rawLast)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// 2. Encoding sanity (`looksEncodedCorrectly`) — a general character-density
//    check, plus the narrow BUG-046 signature (³/¿ landing inside a
//    Cyrillic word, the exact CP1251→Latin-1 mojibake pattern BUG-046
//    documented). Reject, never auto-repair (BUG-046's own conclusion: a
//    blind ³→і repair would corrupt legitimate см³/м³ content elsewhere).
// ---------------------------------------------------------------------------

/**
 * Legitimate math/physics unit tokens that pair a Cyrillic letter directly
 * with `³`/`²` (BUG-046 itself: "³ is legitimate in math/physics — см³,
 * м³ — a blind replace would break them"). Checked whole-token, case
 * folded, so `checkStepContentQa` never flags real units.
 */
const KNOWN_UNIT_TOKENS = new Set([
  "м³", "см³", "дм³", "мм³", "км³", "м²", "см²", "дм²", "мм²", "км²",
]);

/**
 * BUG-046's exact reported pattern: `³` (U+00B3) or `¿` (U+00BF) landing
 * immediately next to a Cyrillic letter *within the same word* — the
 * signature of a CP1251 byte (Ukrainian і/ї) misread as Latin-1. Scoped to
 * whole "words" (letter/digit/³/¿ runs) and explicitly whitelists the known
 * legitimate cubic/square-unit tokens so `см³`/`м³` never trips it — the
 * exact false-positive risk BUG-046's own investigation flagged.
 */
function bug046Signature(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}³¿]+/gu) ?? [];
  for (const token of tokens) {
    if (!/[³¿]/.test(token)) continue;
    // A digit run glued directly to the unit with no space ("10см³") tokenizes
    // as one token together with the leading digits — strip them before the
    // whitelist lookup so digit-adjacent units still match (BUG-047 #2).
    const unitPart = token.replace(/^\p{N}+/u, "");
    if (KNOWN_UNIT_TOKENS.has(token.toLowerCase()) || KNOWN_UNIT_TOKENS.has(unitPart.toLowerCase())) continue;
    if (/\p{Script=Cyrillic}[³¿]|[³¿]\p{Script=Cyrillic}/u.test(token)) return token;
  }
  return null;
}

/** Characters expected in Ukrainian prose: Cyrillic, Latin, digits, whitespace, standard punctuation (including the em/en dash Ukrainian prose uses constantly for asides and reported speech), and the math symbols BUG-046 explicitly keeps legitimate (+ − × ÷ = ° % ² ³). */
const EXPECTED_CHAR_RE = /[\p{Script=Cyrillic}\p{Script=Latin}\p{N}\s.,!?…:;'"«»“”‘’()[\]/%°+\-−×÷=²³_@#&—–]/u;

/** > 1 out-of-range character per ~200 chars of prose (ADR-034's own stated, deliberately conservative threshold). */
const MAX_DISALLOWED_DENSITY = 1 / 200;

export function looksEncodedCorrectly(text: string): { ok: boolean; reason?: string } {
  if (!text.trim()) return { ok: true };

  const bad046 = bug046Signature(text);
  if (bad046) {
    return {
      ok: false,
      reason: `слово «${bad046}» виглядає як пошкоджене кодування (³/¿ поруч із кириличною літерою в тому самому слові) — можливий mojibake CP1251→Latin-1 (BUG-046)`,
    };
  }

  let disallowed = 0;
  for (const ch of text) if (!EXPECTED_CHAR_RE.test(ch)) disallowed++;
  const density = disallowed / text.length;
  if (density > MAX_DISALLOWED_DENSITY) {
    return {
      ok: false,
      reason: `надто велика частка символів поза очікуваним діапазоном кирилиця/латиниця/цифри/пунктуація (${disallowed} з ${text.length} символів)`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. Verbatim-quote-vs-source fidelity — today only the BUG-011 fallback
//    excerpt is marked verbatim (`source_refs[].verbatim`); AI-generated
//    prose is a paraphrase by design and is intentionally NOT checked here
//    (ADR-034: that's `lesson_review`'s + `verifyProblemNumbers`' job).
// ---------------------------------------------------------------------------

export function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whitespace-normalized substring check. A trailing "…" is our own
 * truncation marker (`truncateAtSentenceBoundary`'s word-boundary fallback),
 * never part of the source text, so it is stripped before comparing —
 * otherwise every ellipsis-truncated (but otherwise fine) excerpt would
 * always fail fidelity.
 */
export function isVerbatimSubstring(stepText: string, sourceText: string): boolean {
  const needle = normalizeForCompare(stepText).replace(/…+$/u, "").trim();
  if (!needle) return true;
  return normalizeForCompare(sourceText).includes(needle);
}

export function checkVerbatimFidelity(stepText: string, sourceText: string, stepIndex = 0, field = "textUk"): ContentQaFailure | null {
  if (isVerbatimSubstring(stepText, sourceText)) return null;
  return {
    stepIndex,
    field,
    code: "fidelity",
    reason: "текст кроку не знайдено дослівно (з урахуванням пробілів) у заявленому джерелі (chunks.text) — можлива розбіжність або пошкодження тексту",
  };
}

// ---------------------------------------------------------------------------
// Per-step / per-block orchestration for the normal AI-generation path.
// ---------------------------------------------------------------------------

interface FieldRef {
  field: string;
  text: string;
  kind: ContentFieldKind;
}

function fieldsOfStep(step: GeneratedStep): FieldRef[] {
  const out: FieldRef[] = [];
  if (step.type === "slide") {
    out.push({ field: "textUk", text: step.textUk, kind: "prose" });
    if (step.exampleUk) out.push({ field: "exampleUk", text: step.exampleUk, kind: "label" });
  } else if (step.type === "choice") {
    out.push({ field: "questionUk", text: step.questionUk, kind: "prose" });
    out.push({ field: "explanationUk", text: step.explanationUk, kind: "prose" });
    step.options.forEach((o, i) => {
      out.push({ field: `options[${i}].textUk`, text: o.textUk, kind: "label" });
      if (o.misconceptionUk) out.push({ field: `options[${i}].misconceptionUk`, text: o.misconceptionUk, kind: "prose" });
    });
    step.remediation?.retryVariants.forEach((v, i) => {
      out.push({ field: `remediation.retryVariants[${i}].questionUk`, text: v.questionUk, kind: "prose" });
      out.push({ field: `remediation.retryVariants[${i}].explanationUk`, text: v.explanationUk, kind: "prose" });
      v.options.forEach((o, j) => out.push({ field: `remediation.retryVariants[${i}].options[${j}].textUk`, text: o.textUk, kind: "label" }));
    });
  } else if (step.type === "open") {
    out.push({ field: "questionUk", text: step.questionUk, kind: "prose" });
    out.push({ field: "expectedAnswerUk", text: step.expectedAnswerUk, kind: "label" });
    out.push({ field: "rubricUk", text: step.rubricUk, kind: "prose" });
    step.remediation?.retryVariants.forEach((v, i) => {
      out.push({ field: `remediation.retryVariants[${i}].questionUk`, text: v.questionUk, kind: "prose" });
      out.push({ field: `remediation.retryVariants[${i}].expectedAnswerUk`, text: v.expectedAnswerUk, kind: "label" });
      out.push({ field: `remediation.retryVariants[${i}].rubricUk`, text: v.rubricUk, kind: "prose" });
    });
  } else {
    // "interactive": the model never returns markup (NFR-SAFE-15) — only the
    // fallback text shown when the component itself can't render is prose.
    out.push({ field: "fallbackTextUk", text: step.fallbackTextUk, kind: "prose" });
  }
  return out;
}

/** Completeness + encoding checks over every text field of one step (verbatim fidelity is not part of this — see module doc). */
export function checkStepContentQa(step: GeneratedStep, stepIndex: number): ContentQaFailure[] {
  const failures: ContentQaFailure[] = [];
  for (const f of fieldsOfStep(step)) {
    if (!looksComplete(f.text, f.kind)) {
      failures.push({ stepIndex, field: f.field, code: "completeness", reason: "текст виглядає обірваним (закінчується на середині речення/слова/числа)" });
      continue; // one failure per field is signal enough; don't double-report the same broken field
    }
    const enc = looksEncodedCorrectly(f.text);
    if (!enc.ok) failures.push({ stepIndex, field: f.field, code: "encoding", reason: enc.reason! });
  }
  return failures;
}

/** The full `content_qa` check for one generated block (pipeline.ts's normal AI-generation path). */
export function checkBlockContentQa(block: LessonBlockGenerated): ContentQaResult {
  const failures = block.steps.flatMap((s, i) => checkStepContentQa(s, i));
  return { ok: failures.length === 0, failures };
}

/** One Ukrainian revision note per failure, fed back into `generateDraft`'s `revisionNotes` the same way a reviewer's notes are (pipeline.ts). */
export function contentQaFailureNoteUk(f: ContentQaFailure): string {
  const prefix = `Крок ${f.stepIndex + 1} (${f.field})`;
  if (f.code === "encoding") return `${prefix}: ${f.reason}. Перефразуй без цитування зіпсованих символів.`;
  if (f.code === "completeness") return `${prefix}: ${f.reason}. Перегенеруй з повним, завершеним текстом.`;
  return `${prefix}: ${f.reason}.`;
}

/**
 * The BUG-011 fallback path's own check: a verbatim excerpt gets all three
 * checks (it is both prose and, by construction, claims to be a substring
 * of `sourceText`) — `getOrCreateFallbackBlock` (generate.ts) uses this to
 * decide whether to try the next candidate fragment.
 */
export function checkVerbatimExcerptContentQa(excerpt: string, sourceText: string): ContentQaResult {
  const failures: ContentQaFailure[] = [];
  if (!looksComplete(excerpt, "prose")) {
    failures.push({ stepIndex: 0, field: "excerpt", code: "completeness", reason: "уривок виглядає обірваним (закінчується на середині речення/слова)" });
  }
  const enc = looksEncodedCorrectly(excerpt);
  if (!enc.ok) failures.push({ stepIndex: 0, field: "excerpt", code: "encoding", reason: enc.reason! });
  const fidelity = checkVerbatimFidelity(excerpt, sourceText, 0, "excerpt");
  if (fidelity) failures.push(fidelity);
  return { ok: failures.length === 0, failures };
}
