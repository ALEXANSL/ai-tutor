import "server-only";
import { strFromU8, unzipSync } from "fflate";
import type { LiteratureTopicOut } from "./literature-schema";

/**
 * S33 follow-up (PO decision 2026-09-30, "готую курси сам через ChatGPT/Claude,
 * навіщо повторно платити за генерацію"): a SECOND, $0, fully deterministic
 * path into the exact same `LiteratureTopicOut` shape `runLiteratureExtraction`
 * produces — no AI call anywhere in this file. The PO authors full courses
 * himself (with any chat assistant, on his own time/budget) in a fixed
 * markdown+JSON format he already uses (`lessons/NN.md` frontmatter+markdown,
 * `tests/NN.json`) and uploads the zip; this module is pure text parsing of
 * that already-finished content into our schema, so the SAME
 * `persistLiteratureTopic` (`literatureExtraction.ts`) saves it — no
 * duplicated DB-writing logic, no new tables.
 *
 * Never invents content: every schema field this parser cannot find in the
 * source file gets either a clearly-labelled Ukrainian placeholder (e.g. a
 * missing `work.excerptsUk`) or a generic one ("правильна відповідь — див.
 * підручник" for a missing test explanation) — always paired with an entry
 * in `warnings` so the parent sees exactly what was guessed and can fix the
 * source file instead of trusting a made-up value silently.
 *
 * No new dependency: `fflate` (zip) and hand-rolled frontmatter/markdown
 * parsing (the source format is simple enough — `key: value` frontmatter,
 * `##`/`###`/`####` headings, `-`/numbered lists — that a full YAML/Markdown
 * parser would be more surface than the format needs).
 */

export interface ImportWarning {
  /** `null` for a course-level problem (e.g. an unparsable file), otherwise the topic it concerns. */
  topicNo: number | null;
  field: string;
  message: string;
}

export interface ParsedCourseResult {
  topics: LiteratureTopicOut[];
  warnings: ImportWarning[];
}

// ---------------------------------------------------------------------------
// Frontmatter — hand-rolled, deliberately minimal (see module doc).
// ---------------------------------------------------------------------------

/** One `key: value` frontmatter block, values coerced to string / number / (number|string)[] as their literal syntax implies. */
export type FrontmatterValue = string | number | (string | number)[];

export function parseFrontmatter(raw: string): { data: Record<string, FrontmatterValue>; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { data: {}, body: normalized };
  const [, fmBlock, body] = match;
  const data: Record<string, FrontmatterValue> = {};
  for (const line of fmBlock!.split("\n")) {
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    data[key!] = parseFrontmatterValue(rawValue!.trim());
  }
  return { data, body: body ?? "" };
}

function parseFrontmatterValue(v: string): FrontmatterValue {
  if (v.startsWith("[") && v.endsWith("]")) {
    return v
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => (/^-?\d+(\.\d+)?$/.test(part) ? Number(part) : stripQuotes(part)));
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return stripQuotes(v);
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

function fmString(data: Record<string, FrontmatterValue>, key: string): string | null {
  const v = data[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

function fmNumber(data: Record<string, FrontmatterValue>, key: string): number | null {
  const v = data[key];
  return typeof v === "number" ? v : null;
}

function fmPageRange(data: Record<string, FrontmatterValue>, key: string): [number | null, number | null] {
  const v = data[key];
  if (!Array.isArray(v)) return [null, null];
  const [from, to] = v;
  return [typeof from === "number" ? from : null, typeof to === "number" ? to : null];
}

// ---------------------------------------------------------------------------
// Markdown body — section/heading extraction.
// ---------------------------------------------------------------------------

/** Text of the first `## <heading>` section (until the next `## ` heading or end of document). Trimmed; `null` if the heading is absent. */
function section(body: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${escapeRe(heading)}\\s*$`, "m");
  const m = re.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = /^##\s+/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strips markdown emphasis markers (`**bold**`, `__bold__`) from a plain-text
 * field. Several of our schema's string fields (`keyConceptsUk`, `work.*`)
 * are NOT markdown (unlike `explanationMdUk`, which keeps its `Md` suffix
 * and its formatting on purpose) — the source format bolds term names in
 * its bullet lists, but the `**`/`__` characters themselves would otherwise
 * trip `content-qa.ts`'s "unexpected character ratio" check and mark an
 * otherwise-fine topic `needs_review` for no real reason.
 */
function stripMarkdownEmphasis(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
}

/** `- item` bullet list lines (with the leading marker stripped), in order. */
function bulletItems(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => stripMarkdownEmphasis(l.slice(2).trim()));
}

/** A `**Label:**`/`**Label.**` prefixed paragraph's text, from a blank-line-separated block of paragraphs. */
function labelledParagraph(text: string, label: string): string | null {
  const re = new RegExp(`\\*\\*${escapeRe(label)}[.:]?\\*\\*\\s*[.:]?\\s*(.+?)(?=\\n\\n|$)`, "s");
  const m = re.exec(text);
  return m ? stripMarkdownEmphasis(m[1]!.trim().replace(/\s+/g, " ")) : null;
}

const WORK_QUOTE_RE = /[«"](.+?)[»"]/;

/** The literary work's own title out of a topic title such as `Даніель Дефо. «Пригоди Робінзона Крузо»` — the quoted part, or the whole title when nothing is quoted (e.g. `Мацуо Басьо. Хайку`). */
function workTitleFromTopicTitle(topicTitle: string): string {
  const m = WORK_QUOTE_RE.exec(topicTitle);
  return m ? m[1]!.trim() : topicTitle;
}

interface ParsedQuestionItem {
  number: string;
  textUk: string;
}
interface ParsedQuestionGroup {
  labelUk: string;
  page: number | null;
  pdfPage: number | null;
  items: ParsedQuestionItem[];
}
interface ParsedSublesson {
  no: string;
  titleUk: string;
  questionGroups: ParsedQuestionGroup[];
}

const SUBLESSON_HEADING_RE = /^###\s+Урок\s+([\d.]+)\.\s*(.+)$/;
const GROUP_HEADING_RE = /^####\s+(.+?)\s*\(([^)]*)\)\s*$/;
const NUMBERED_ITEM_RE = /^(\S+)\.\s+(.+)$/;

/** `## Уроки` → one `### Урок N.M. <title>` per sub-lesson, each with its `#### <label> (с. P; PDF Q)` question groups. */
function parseSublessons(lessonsSection: string): ParsedSublesson[] {
  const lines = lessonsSection.split("\n");
  const sublessons: ParsedSublesson[] = [];
  let current: ParsedSublesson | null = null;
  let currentGroup: ParsedQuestionGroup | null = null;

  const flushGroup = () => {
    if (current && currentGroup) current.questionGroups.push(currentGroup);
    currentGroup = null;
  };
  const flushSublesson = () => {
    flushGroup();
    if (current) sublessons.push(current);
    current = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const subMatch = SUBLESSON_HEADING_RE.exec(line);
    if (subMatch) {
      flushSublesson();
      current = { no: subMatch[1]!, titleUk: subMatch[2]!.trim(), questionGroups: [] };
      continue;
    }
    const groupMatch = GROUP_HEADING_RE.exec(line);
    if (groupMatch && current) {
      flushGroup();
      const [, label, paren] = groupMatch;
      const pageM = /с\.\s*(\d+)/.exec(paren!);
      const pdfM = /PDF\s*(\d+)/.exec(paren!);
      currentGroup = {
        labelUk: label!.trim(),
        page: pageM ? Number(pageM[1]) : null,
        pdfPage: pdfM ? Number(pdfM[1]) : null,
        items: [],
      };
      continue;
    }
    const itemMatch = currentGroup ? NUMBERED_ITEM_RE.exec(line) : null;
    if (itemMatch) {
      currentGroup!.items.push({ number: itemMatch[1]!, textUk: itemMatch[2]!.trim() });
    }
  }
  flushSublesson();
  return sublessons;
}

// ---------------------------------------------------------------------------
// One `lessons/NN.md` → LiteratureTopicOut (minus `test`, added separately).
// ---------------------------------------------------------------------------

export function parseLessonMarkdown(raw: string, warn: (field: string, message: string) => void): Omit<LiteratureTopicOut, "test"> {
  const { data, body } = parseFrontmatter(raw);

  const topicNo = fmNumber(data, "topic") ?? 0;
  if (!topicNo) warn("topicNo", "не вдалося прочитати номер теми (`topic:`) у frontmatter — використано 0");

  const titleUk = fmString(data, "title") ?? "(тема без назви)";
  if (!fmString(data, "title")) warn("titleUk", "не вказано `title:` у frontmatter");

  const [textbookPageFrom, textbookPageTo] = fmPageRange(data, "textbook_pages");
  const [pdfPageFrom, pdfPageTo] = fmPageRange(data, "pdf_pages");

  const goalSection = section(body, "Мета");
  const goalUk = goalSection ? stripMarkdownEmphasis(goalSection) : "Мета уроку буде уточнена пізніше.";
  if (!goalSection) warn("goalUk", "розділ «## Мета» відсутній — використано заглушку");

  const conceptsText = section(body, "Ключові поняття");
  const keyConceptsUk = conceptsText ? bulletItems(conceptsText) : [];
  if (keyConceptsUk.length === 0) warn("keyConceptsUk", "розділ «## Ключові поняття» відсутній або порожній");

  const explanationSection = section(body, "Матеріал для пояснення");
  const explanationMdUk = explanationSection && explanationSection.length > 0 ? explanationSection : "Матеріал для пояснення буде додано пізніше.";
  if (!explanationSection) warn("explanationMdUk", "розділ «## Матеріал для пояснення» відсутній — використано заглушку");

  const workSection = section(body, "Твір");
  let work: LiteratureTopicOut["work"] = null;
  if (workSection) {
    const summaryUk = labelledParagraph(workSection, "Стислий зміст");
    const charactersUk = labelledParagraph(workSection, "Персонажі") ?? undefined;
    const ideaUk = labelledParagraph(workSection, "Ідея") ?? undefined;
    const workTitleUk = workTitleFromTopicTitle(titleUk);

    let excerptsUk = labelledParagraph(workSection, "Уривки") ?? labelledParagraph(workSection, "Цитати");
    if (!excerptsUk) {
      excerptsUk =
        textbookPageFrom != null && textbookPageTo != null
          ? `Уривки не включені до цього імпортованого матеріалу — повний текст твору читайте в підручнику (с. ${textbookPageFrom}–${textbookPageTo}).`
          : "Уривки не включені до цього імпортованого матеріалу — повний текст твору читайте в підручнику.";
      warn("work.excerptsUk", "джерельний файл не містить окремих цитат/уривків твору — використано заглушку-посилання на підручник");
    }

    if (!summaryUk) warn("work.summaryUk", "розділ «Стислий зміст» твору не знайдено — використано заглушку");

    work = {
      titleUk: workTitleUk,
      excerptsUk,
      summaryUk: summaryUk ?? "Стислий зміст буде додано пізніше.",
      charactersUk,
      ideaUk,
    };
  }

  const lessonsSection = section(body, "Уроки") ?? "";
  const parsedSublessons = parseSublessons(lessonsSection);
  const sublessons: LiteratureTopicOut["sublessons"] =
    parsedSublessons.length > 0
      ? parsedSublessons.map((sl) => ({
          no: sl.no,
          titleUk: sl.titleUk,
          questionGroups: sl.questionGroups.map((g) => ({
            labelUk: g.labelUk,
            page: g.page,
            pdfPage: g.pdfPage,
            items: g.items,
          })),
        }))
      : [{ no: "1", titleUk, questionGroups: [] }];
  if (parsedSublessons.length === 0) warn("sublessons", "розділ «## Уроки» не розпізнано — створено один заглушковий підурок без запитань");

  const teacherNoteUk = section(body, "Для вчителя / ШІ-репетитора") ?? undefined;

  return {
    topicNo,
    sectionTitleUk: fmString(data, "section") ?? undefined,
    titleUk,
    textbookPageFrom,
    textbookPageTo,
    pdfPageFrom,
    pdfPageTo,
    goalUk,
    keyConceptsUk,
    explanationMdUk,
    work,
    sublessons,
    teacherNoteUk,
  };
}

// ---------------------------------------------------------------------------
// One `tests/NN.json` → LiteratureTopicOut["test"].
// ---------------------------------------------------------------------------

interface RawTestQuestion {
  id?: unknown;
  type?: unknown;
  question?: unknown;
  options?: unknown;
  answer?: unknown;
  left?: unknown;
  right?: unknown;
  items?: unknown;
  explanation?: unknown;
}

const KNOWN_TYPES = new Set(["single", "multiple", "truefalse", "match", "order", "open"]);

export function parseTestJson(raw: string, topicNo: number, warn: (field: string, message: string) => void): LiteratureTopicOut["test"] {
  let parsed: { questions?: unknown };
  try {
    parsed = JSON.parse(raw) as { questions?: unknown };
  } catch {
    warn("test", "не вдалося розібрати JSON тесту — тест буде порожнім (не пройде вимогу мінімум 3 запитання)");
    return { questions: [] };
  }
  const rawQuestions = Array.isArray(parsed.questions) ? (parsed.questions as RawTestQuestion[]) : [];
  const questions: LiteratureTopicOut["test"]["questions"] = [];

  rawQuestions.forEach((q, i) => {
    const type = typeof q.type === "string" && KNOWN_TYPES.has(q.type) ? (q.type as "single" | "multiple" | "truefalse" | "match" | "order" | "open") : null;
    if (!type) {
      warn(`test.questions[${i}]`, `невідомий тип запитання "${String(q.type)}" — запитання пропущено`);
      return;
    }
    const id = typeof q.id === "string" && q.id.length > 0 ? q.id : `${topicNo}-q${i + 1}`;
    const questionUk = typeof q.question === "string" && q.question.length > 0 ? q.question : "(запитання без тексту)";
    if (typeof q.question !== "string" || q.question.length === 0) warn(`test.questions[${i}].questionUk`, "текст запитання відсутній — використано заглушку");

    const explanationUk = typeof q.explanation === "string" && q.explanation.length > 0 ? q.explanation : "Правильну відповідь перевірте за підручником.";
    if (typeof q.explanation !== "string" || q.explanation.length === 0) {
      warn(`test.questions[${i}].explanationUk`, "пояснення відповіді відсутнє у джерелі — використано типове формулювання");
    }

    if (type === "match") {
      const left = Array.isArray(q.left) ? (q.left as unknown[]).map(String) : [];
      const answerMap = q.answer && typeof q.answer === "object" && !Array.isArray(q.answer) ? (q.answer as Record<string, unknown>) : {};
      const pairs = left.map((l) => ({ leftUk: l, rightUk: String(answerMap[l] ?? "") }));
      if (pairs.some((p) => !p.rightUk)) warn(`test.questions[${i}]`, "не всі пари «match» мають праву частину у відповіді");
      questions.push({ id, type, questionUk, pairs, explanationUk });
      return;
    }

    if (type === "order") {
      const items = Array.isArray(q.items) ? (q.items as unknown[]).map(String) : undefined;
      const answer = Array.isArray(q.answer) ? (q.answer as unknown[]).map(String) : items;
      questions.push({ id, type, questionUk, options: items, answer, explanationUk });
      return;
    }

    if (type === "open") {
      questions.push({ id, type, questionUk, explanationUk });
      return;
    }

    // single / multiple / truefalse
    const options = Array.isArray(q.options) ? (q.options as unknown[]).map(String) : undefined;
    const answer =
      typeof q.answer === "number"
        ? q.answer
        : Array.isArray(q.answer)
          ? (q.answer as unknown[]).every((v) => typeof v === "number")
            ? (q.answer as number[])
            : (q.answer as unknown[]).map(String)
          : undefined;
    questions.push({ id, type, questionUk, options, answer, explanationUk });
  });

  if (questions.length < 3) {
    warn("test.questions", `лише ${questions.length} придатних запитань (потрібно мінімум 3) — тема буде позначена як "потребує перегляду"`);
    while (questions.length < 3) {
      questions.push({
        id: `${topicNo}-placeholder${questions.length + 1}`,
        type: "open",
        questionUk: "(запитання буде додано)",
        explanationUk: "Це заглушкове запитання — доповніть тест вручну.",
      });
    }
  }

  return { questions };
}

// ---------------------------------------------------------------------------
// Whole-course zip.
// ---------------------------------------------------------------------------

const LESSON_PATH_RE = /(^|\/)lessons\/(\d+)\.md$/;

/** The zip entry key ending in `suffix` (path-segment aware — never matches a shorter filename that happens to end with the same characters). */
function findEntryBySuffix(entries: Record<string, Uint8Array>, suffix: string): string | null {
  const normalizedSuffix = suffix.replace(/^\.?\//, "");
  for (const key of Object.keys(entries)) {
    if (key === normalizedSuffix || key.endsWith(`/${normalizedSuffix}`)) return key;
  }
  return null;
}

/**
 * Parses a whole course zip (the PO's own format — `README.md` +
 * `course_index.json` + `lessons/NN.md` + `tests/NN.json`) into the same
 * `LiteratureTopicOut[]` `runLiteratureExtraction` produces. Pure/sync, no
 * I/O beyond `unzipSync` on already-read bytes (mirrors
 * `manual-batch.ts`'s pattern) — safe to unit-test directly and to call from
 * both the admin server action and the one-off CLI script.
 */
export function parseLiteratureCourseZip(zipBytes: Uint8Array): ParsedCourseResult {
  const entries = unzipSync(zipBytes);
  const warnings: ImportWarning[] = [];
  const topics: LiteratureTopicOut[] = [];

  const lessonKeys = Object.keys(entries)
    .map((key) => ({ key, m: LESSON_PATH_RE.exec(key) }))
    .filter((e): e is { key: string; m: RegExpExecArray } => e.m != null)
    .sort((a, b) => Number(a.m[2]) - Number(b.m[2]));

  if (lessonKeys.length === 0) {
    warnings.push({ topicNo: null, field: "lessons", message: "у архіві не знайдено жодного файлу lessons/NN.md — перевірте структуру zip" });
    return { topics, warnings };
  }

  for (const { key } of lessonKeys) {
    const raw = strFromU8(entries[key]!);
    const { data: fm } = parseFrontmatter(raw);
    let topicNo = fmNumber(fm, "topic") ?? 0;
    const localWarn = (field: string, message: string) => warnings.push({ topicNo, field, message });

    const partial = parseLessonMarkdown(raw, localWarn);
    topicNo = partial.topicNo;

    const testFileRef = fmString(fm, "test_file");
    const nn = LESSON_PATH_RE.exec(key)![2];
    const testKey = (testFileRef && findEntryBySuffix(entries, testFileRef)) ?? findEntryBySuffix(entries, `tests/${nn}.json`);

    let test: LiteratureTopicOut["test"];
    if (!testKey) {
      warnings.push({ topicNo, field: "test", message: `файл тесту не знайдено (очікувався ${testFileRef ?? `tests/${nn}.json`}) — тема буде без тесту` });
      test = { questions: [] };
      for (let i = 0; i < 3; i++) {
        test.questions.push({
          id: `${topicNo}-missing${i + 1}`,
          type: "open",
          questionUk: "(тест відсутній у джерелі)",
          explanationUk: "Файл тесту не знайдено в архіві — додайте його вручну.",
        });
      }
    } else {
      test = parseTestJson(strFromU8(entries[testKey]!), topicNo, localWarn);
    }

    topics.push({ ...partial, test });
  }

  return { topics, warnings };
}
