import { z } from "zod";
import type { StructureStrategyKey } from "@/core/registries/learning";

/**
 * Structure step of the universal pipeline (docs/02 9.1, ADR-017): prompt
 * input, output schema and the pure rules that apply the model's answer
 * without overwriting manual corrections (US-2.2 KP-2, US-2.6 KP-1).
 */

export const PROMPT_VERSION = "indexing_structure.v1";

export function buildStructureSchema(kinds: string[], subjectCodes: string[]) {
  const pages = { page_from: z.number().int().nullable(), page_to: z.number().int().nullable() };
  return z.object({
    title: z.string(),
    kind: z.enum(kinds as [string, ...string[]]),
    subject_code: z.enum(["none", ...subjectCodes] as [string, ...string[]]),
    grade: z.number().int().nullable(),
    sections: z.array(
      z.object({
        title: z.string(),
        ...pages,
        topics: z.array(z.object({ title: z.string(), ...pages })),
      }),
    ),
    dependencies: z.array(z.object({ topic: z.string(), depends_on: z.string() })),
    related_topics: z.array(z.string()),
    // ADR-029 (US-2.8): numbered textbook exercises/problems, recognized as
    // part of this SAME one-per-book call (no separate AI call, КП-3) — a
    // top-level array (not nested in sections/topics: problem numbering and
    // section boundaries are different axes, per the ADR).
    problems: z.array(z.object({ number: z.string().min(1).max(12), page: z.number().int().nullable() })).max(500),
  });
}

export type StructureAnswer = z.infer<ReturnType<typeof buildStructureSchema>>;

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
 * Compact outline for the model: full text of the first/last pages (where the
 * table of contents usually is) and, for every other page, its beginning plus
 * heading-like lines. Keeps the structure call ≈ $0.1–0.5 per book (docs/03 3.8).
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

/** Cleans the model's answer and applies the strategy of the source type. */
export function normalizeSections(answer: Pick<StructureAnswer, "sections">, strategy: StructureStrategyKey, pageCount: number): NormalizedSection[] {
  const sections = answer.sections
    .map((s) => ({
      title: s.title.trim().slice(0, 300),
      page_from: clampPage(s.page_from, pageCount),
      page_to: clampPage(s.page_to, pageCount),
      topics:
        strategy === "textbook"
          ? s.topics
              .map((t) => ({ title: t.title.trim().slice(0, 300), page_from: clampPage(t.page_from, pageCount), page_to: clampPage(t.page_to, pageCount) }))
              .filter((t) => t.title)
          : [],
    }))
    .filter((s) => s.title);
  return fillRanges(sections, pageCount).map((s) => ({ ...s, topics: fillRanges(s.topics, s.page_to) }));
}

/**
 * ADR-029 §1 (US-2.8): cleans the model's `problems` answer the same way
 * `normalizeSections` cleans `sections` — gated on `strategy === "textbook"`
 * (MVP scope, see the ADR's Альтернативи) and NEVER inventing a number: an
 * empty/unparseable number, an out-of-range or missing page, or a number
 * containing whitespace (a sure sign the model merged unrelated text) is
 * silently dropped rather than guessed at (КП-2). Dedupes by
 * `page:number.toLowerCase()` so the same exercise mentioned twice in the
 * outline (e.g. both in a table of contents and on its own page) becomes one
 * row, keeping the first-seen display casing.
 */
export function normalizeProblems(
  answer: Pick<StructureAnswer, "problems">,
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
