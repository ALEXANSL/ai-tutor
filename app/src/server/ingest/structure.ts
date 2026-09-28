import { z } from "zod";
import type { StructureStrategyKey } from "@/core/registries/learning";

/**
 * Structure steps of the universal pipeline (docs/02 9.1, ADR-017, ADR-032):
 * prompt input, output schemas and the pure rules that apply the model's
 * answer without overwriting manual corrections (US-2.2 KP-2, US-2.6 KP-1).
 *
 * ADR-032 split the single whole-book `indexing_structure` call into two
 * passes to bound each call's output size (the root cause of a real prod
 * failure — deep section hierarchies / hundreds of numbered exercises
 * pushed the old single call past `max_tokens`/the provider timeout):
 *  - `indexing_outline` (PROMPT_VERSION_OUTLINE): section BOUNDARIES only —
 *    small, predictable output regardless of book size.
 *  - `indexing_structure` (PROMPT_VERSION_SECTION): topics/problems/
 *    dependencies/related_topics for ONE section at a time, given that
 *    section's full (uncompressed) text.
 */

export const PROMPT_VERSION_OUTLINE = "indexing_outline.v1";
export const PROMPT_VERSION_SECTION = "indexing_structure.v2";

const pageBounds = { page_from: z.number().int().nullable(), page_to: z.number().int().nullable() };

/** Pass 1 (ADR-032): book classification + section boundaries only — no topics/problems/dependencies. */
export function buildOutlineSchema(kinds: string[], subjectCodes: string[]) {
  return z.object({
    title: z.string(),
    kind: z.enum(kinds as [string, ...string[]]),
    subject_code: z.enum(["none", ...subjectCodes] as [string, ...string[]]),
    grade: z.number().int().nullable(),
    sections: z.array(z.object({ title: z.string(), ...pageBounds })),
  });
}
export type OutlineAnswer = z.infer<ReturnType<typeof buildOutlineSchema>>;

/**
 * Pass 2 (ADR-032): one call PER SECTION — topics of that section, its
 * numbered exercises (ADR-029), dependencies between ITS OWN topics, and
 * (non-textbook only) related_topics. Bounded output: at most a few dozen
 * topics/exercises per section, an order of magnitude below the old
 * whole-book 500-problem ceiling.
 */
export function buildSectionSchema() {
  return z.object({
    topics: z.array(z.object({ title: z.string(), ...pageBounds })),
    dependencies: z.array(z.object({ topic: z.string(), depends_on: z.string() })),
    related_topics: z.array(z.string()),
    problems: z.array(z.object({ number: z.string().min(1).max(12), page: z.number().int().nullable() })).max(500),
  });
}
export type SectionAnswer = z.infer<ReturnType<typeof buildSectionSchema>>;

export interface PageText {
  page: number;
  locator: string | null;
  text: string;
}

// Note: \b is ASCII-only in JS regexes, so word ends are spelled out for Cyrillic.
const HEADING =
  /^(§\s*\d|(розділ|тема|глава|частина|урок|параграф|зміст|chapter|part|section)(?=[\s.:\d]|$)|\d{1,2}(\.\d{1,2}){0,2}[.)]?\s+\p{Lu})/iu;

export function isHeadingLike(line: string): boolean {
  const l = line.trim();
  if (l.length < 3 || l.length > 90) return false;
  if (HEADING.test(l)) return true;
  const letters = l.match(/\p{L}/gu) ?? [];
  const upper = l.match(/\p{Lu}/gu) ?? [];
  return letters.length >= 4 && upper.length / letters.length > 0.7;
}

/**
 * Compact outline for the model (pass 1 — `indexing_outline`): full text of
 * the first/last pages (where the table of contents usually is) and, for
 * every other page, its beginning plus heading-like lines. Keeps the outline
 * call cheap and its output small (section boundaries only, ADR-032) —
 * unchanged from the pre-ADR-032 single-call outline extract.
 */
export function buildOutline(pages: PageText[], opts: { maxChars?: number; edgePages?: number } = {}): string {
  const maxChars = opts.maxChars ?? 120_000;
  const edge = opts.edgePages ?? 8;
  const n = pages.length;
  const render = (headChars: number, edgeChars: number) =>
    pages
      .map((p, i) => {
        const isEdge = i < edge || i >= n - edge;
        const label = p.locator ? `Стор. ${p.page} (${p.locator})` : `Стор. ${p.page}`;
        if (isEdge) return `--- ${label} ---\n${p.text.slice(0, edgeChars)}`;
        const headings = [...new Set(p.text.split("\n").filter(isHeadingLike))].slice(0, 6);
        const head = p.text.slice(0, headChars).replace(/\n/g, " ");
        return `--- ${label} ---\n${head}${headings.length ? `\n# ${headings.join("\n# ")}` : ""}`;
      })
      .join("\n");
  let head = 300;
  let edgeChars = 3500;
  let out = render(head, edgeChars);
  while (out.length > maxChars && head > 40) {
    head = Math.floor(head * 0.6);
    edgeChars = Math.max(800, Math.floor(edgeChars * 0.8));
    out = render(head, edgeChars);
  }
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

/**
 * Full, UNCOMPRESSED text of one section's pages (pass 2 — `indexing_structure`
 * per section, ADR-032): unlike `buildOutline`, this never truncates or
 * summarizes — a section is a fraction of the book (typically 15–30 pages),
 * so its full text stays well within one call's input budget while giving
 * the model much better material than the old whole-book compressed extract.
 */
export function buildSectionText(pages: PageText[]): string {
  return pages
    .map((p) => `--- ${p.locator ? `Стор. ${p.page} (${p.locator})` : `Стор. ${p.page}`} ---\n${p.text}`)
    .join("\n");
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => values[k] ?? m);
}

/** Splits the prompt file into system and user parts. */
export function splitPrompt(file: string): { system: string; user: string } {
  const withoutComments = file.replace(/<!--[\s\S]*?-->/g, "");
  const [, system = "", user = ""] = withoutComments.split(/^=== (?:SYSTEM|USER) ===$/m);
  return { system: system.trim(), user: user.trim() };
}

export interface NormalizedTopic {
  title: string;
  page_from: number | null;
  page_to: number | null;
}
export interface NormalizedSection extends NormalizedTopic {
  topics: NormalizedTopic[];
}

const clampPage = (p: number | null, max: number) => (p == null || !Number.isFinite(p) ? null : Math.min(Math.max(1, Math.round(p)), Math.max(1, max)));

function fillRanges<T extends NormalizedTopic>(items: T[], upper: number | null): T[] {
  return items.map((it, i) => {
    let to = it.page_to;
    if (to == null) {
      const nextFrom = items.slice(i + 1).find((x) => x.page_from != null)?.page_from ?? null;
      to = nextFrom != null ? Math.max(it.page_from ?? nextFrom, nextFrom - 1) : upper;
    }
    if (it.page_from != null && to != null && to < it.page_from) to = it.page_from;
    return { ...it, page_to: to };
  });
}

/** Cleans pass 1's answer: book-wide section boundaries only (ADR-032). */
export function normalizeOutlineSections(answer: Pick<OutlineAnswer, "sections">, pageCount: number): NormalizedTopic[] {
  const sections = answer.sections
    .map((s) => ({ title: s.title.trim().slice(0, 300), page_from: clampPage(s.page_from, pageCount), page_to: clampPage(s.page_to, pageCount) }))
    .filter((s) => s.title);
  return fillRanges(sections, pageCount);
}

/**
 * Cleans pass 2's `topics` answer for ONE section (ADR-032) — same rules as
 * the pre-ADR-032 whole-book version, but the fill-range upper bound is the
 * SECTION's own `page_to` (topics can never spill past their section).
 */
export function normalizeSectionTopics(
  answer: Pick<SectionAnswer, "topics">,
  strategy: StructureStrategyKey,
  pageCount: number,
  sectionPageTo: number | null,
): NormalizedTopic[] {
  if (strategy !== "textbook") return [];
  const topics = answer.topics
    .map((t) => ({ title: t.title.trim().slice(0, 300), page_from: clampPage(t.page_from, pageCount), page_to: clampPage(t.page_to, pageCount) }))
    .filter((t) => t.title);
  return fillRanges(topics, sectionPageTo);
}

/**
 * ADR-029 §1 (US-2.8): cleans the model's `problems` answer the same way
 * `normalizeSectionTopics` cleans `topics` — gated on `strategy === "textbook"`
 * (MVP scope, see the ADR's Альтернативи) and NEVER inventing a number: an
 * empty/unparseable number, an out-of-range or missing page, or a number
 * containing whitespace (a sure sign the model merged unrelated text) is
 * silently dropped rather than guessed at (КП-2). Dedupes by
 * `page:number.toLowerCase()` so the same exercise mentioned twice in the
 * outline (e.g. both in a table of contents and on its own page) becomes one
 * row, keeping the first-seen display casing.
 */
export function normalizeProblems(
  answer: Pick<SectionAnswer, "problems">,
  strategy: StructureStrategyKey,
  pageCount: number,
): { number: string; page: number }[] {
  if (strategy !== "textbook") return [];
  const seen = new Map<string, { number: string; page: number }>();
  for (const p of answer.problems) {
    const number = p.number.trim().slice(0, 12);
    const page = clampPage(p.page, pageCount);
    if (!number || page == null || /\s/.test(number)) continue;
    const key = `${page}:${number.toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, { number, page });
  }
  return [...seen.values()];
}

export const titleKey = (t: string) =>
  t
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.:;,!?…]+$/u, "")
    .trim();

export interface Existing {
  id: string;
  title: string;
  manual_override: boolean;
}

/**
 * Re-indexing keeps identities: incoming items are matched to existing rows by
 * title; manual rows are never updated or deleted; unmatched automatic rows go.
 * ADR-032: used both book-wide (sections, pass 1) and per-section (topics,
 * pass 2 — the caller scopes `existing` to `section_id = :sectionId` so a
 * topic never merges with one from a different section on re-index).
 */
export function mergeByTitle(existing: Existing[], incoming: { title: string }[]) {
  const byKey = new Map(existing.map((e) => [titleKey(e.title), e]));
  const matched = new Set<string>();
  const plan = incoming.map((inc) => {
    const hit = byKey.get(titleKey(inc.title));
    if (hit && !matched.has(hit.id)) {
      matched.add(hit.id);
      return { action: hit.manual_override ? ("keep" as const) : ("update" as const), id: hit.id };
    }
    return { action: "insert" as const, id: null };
  });
  const remove = existing.filter((e) => !matched.has(e.id) && !e.manual_override).map((e) => e.id);
  return { plan, remove };
}

export interface Ranged {
  id: string;
  page_from: number | null;
  page_to: number | null;
}

/** The narrowest range that contains the page (a topic inside a section). */
export function narrowestContaining(page: number | null, items: Ranged[]): string | null {
  if (page == null) return null;
  let best: Ranged | null = null;
  for (const it of items) {
    if (it.page_from == null || it.page_to == null) continue;
    if (page < it.page_from || page > it.page_to) continue;
    if (!best || it.page_to - it.page_from < best.page_to! - best.page_from!) best = it;
  }
  return best?.id ?? null;
}

export interface TitledRange extends Ranged {
  title: string;
}

/**
 * D-106: the single closest title to show next to a lesson step's page
 * citation — the narrowest of a material's sections/topics whose page range
 * contains the page. Topics and sections can be passed in the same list
 * (e.g. `assign_chunk_structure`'s SQL twin picks each independently, but a
 * textbook topic's range is always inside its parent section's, so
 * `narrowestContaining` naturally prefers the topic without any extra
 * bookkeeping here). Returns `null` when the page falls outside every
 * indexed range (untitled front matter, a page past the last section, …) —
 * callers fall back to showing the page alone.
 */
export function narrowestTitleFor(page: number | null, items: TitledRange[]): string | null {
  const id = narrowestContaining(page, items);
  return id == null ? null : (items.find((it) => it.id === id)?.title ?? null);
}
