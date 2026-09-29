import "server-only";
import { checkStepContentQa, checkVerbatimFidelity, type ContentQaFailure } from "./content-qa";
import type { GeneratedStep } from "./schema";

/**
 * ADR-034 § "Ретроактивний sweep" — the pure/testable pieces of the one-time
 * ops script (`scripts/content-qa-sweep.ts`): reconstructing a saved
 * `library_steps` row into the `GeneratedStep` shape `content-qa.ts` already
 * checks, deciding which failures are high-confidence enough to
 * auto-transition a block to `needs_review`, and the BUG-046 known-defect-
 * book name match. Kept out of the script file itself so it can be unit
 * tested without a live database (the script's `main()` is DB orchestration
 * only — see its own file for the full ADR-034 write-up).
 */

export interface RawStepRow {
  id: string;
  sort_order: number;
  type: string;
  content: Record<string, unknown>;
  visual: Record<string, unknown>;
  source_refs: { materialId: string; page: number | null; verbatim?: boolean }[];
}

/**
 * Reconstructs a `GeneratedStep` from a saved `library_steps` row
 * (`{type, content, visual, source_refs}`, exactly `generate.ts`'s
 * `toStepRow` output) — glue only, no check-logic duplication. Unknown step
 * types (`voice_dialog`/`match`/`mini_game`/`photo`) are not produced by
 * `lesson_generation` today (`buildLessonBlockSchema` only ever emits
 * slide/choice/open/interactive) and have no matching `GeneratedStep`
 * variant to check against — skipped, not guessed at.
 */
export function toGeneratedStep(row: RawStepRow): GeneratedStep | null {
  const c = row.content ?? {};
  const v = row.visual ?? {};
  const sourceRefs = (row.source_refs ?? []) as GeneratedStep["sourceRefs"];
  switch (row.type) {
    case "slide":
      return { type: "slide", textUk: String(c.textUk ?? ""), exampleUk: c.exampleUk ? String(c.exampleUk) : undefined, sourceRefs };
    case "choice":
      return {
        type: "choice",
        questionUk: String(c.questionUk ?? ""),
        options: (c.options as { id: string; textUk: string; misconceptionUk?: string }[]) ?? [],
        correctOptionId: String(c.correctOptionId ?? ""),
        explanationUk: String(c.explanationUk ?? ""),
        remediation: c.remediation as { retryVariants: { questionUk: string; options: { id: string; textUk: string }[]; correctOptionId: string; explanationUk: string }[] } | undefined,
        sourceRefs,
      };
    case "open":
      return {
        type: "open",
        questionUk: String(c.questionUk ?? ""),
        expectedAnswerUk: String(c.expectedAnswerUk ?? ""),
        rubricUk: String(c.rubricUk ?? ""),
        remediation: c.remediation as { retryVariants: { questionUk: string; expectedAnswerUk: string; rubricUk: string }[] } | undefined,
        sourceRefs,
      };
    case "interactive":
      return {
        type: "interactive",
        component: String(v.component ?? ""),
        v: Number(v.v ?? 1),
        props: v.props,
        fallbackTextUk: String(v.fallback_text ?? ""),
        sourceRefs,
      };
    default:
      return null; // voice_dialog / match / mini_game / photo — not covered by content_qa today.
  }
}

export interface ChunkLookup {
  (materialId: string, page: number): Promise<string | null>;
}

export interface ItemCheckResult {
  failures: ContentQaFailure[];
  checkedSteps: number;
  skippedSteps: number;
}

/**
 * Same aggregation `checkBlockContentQa` does (`content-qa.ts`) over a
 * reconstructed step list, plus the verbatim-fidelity check against the
 * step's own claimed `chunks.text` source for any `source_refs[].verbatim`
 * ref. `lookupChunkText` is injected so this function needs no DB client of
 * its own — the script passes a real Supabase lookup, tests pass a fake map.
 */
export async function checkItemSteps(rows: RawStepRow[], lookupChunkText: ChunkLookup): Promise<ItemCheckResult> {
  const failures: ContentQaFailure[] = [];
  let checkedSteps = 0;
  let skippedSteps = 0;

  for (const row of rows) {
    const step = toGeneratedStep(row);
    if (!step) {
      skippedSteps++;
      continue;
    }
    checkedSteps++;
    failures.push(...checkStepContentQa(step, row.sort_order));

    const verbatimRefs = (row.source_refs ?? []).filter((r) => r.verbatim === true);
    if (verbatimRefs.length === 0) continue;
    // Today only the BUG-011 fallback slide step is ever marked verbatim
    // (ADR-034) and its quoted text is always `content.textUk`.
    const stepText = step.type === "slide" ? step.textUk : null;
    if (!stepText) continue;
    for (const ref of verbatimRefs) {
      if (ref.page == null) continue;
      const sourceText = await lookupChunkText(ref.materialId, ref.page);
      if (sourceText == null) continue; // source page itself missing/removed — not this check's job to flag that.
      const failure = checkVerbatimFidelity(stepText, sourceText, row.sort_order, "textUk");
      if (failure) failures.push(failure);
    }
  }
  return { failures, checkedSteps, skippedSteps };
}

/**
 * High-confidence vs. borderline failures — conservative by explicit
 * instruction: only the clearest, lowest-false-positive-risk classes
 * auto-transition a block's `status` to `needs_review` in the sweep. The
 * generic character-density encoding failure (not the narrow BUG-046
 * signature) is deliberately left borderline: flagged for a human, not
 * auto-hidden.
 */
export function isHighConfidenceFailure(f: ContentQaFailure): boolean {
  if (f.code === "completeness") return true; // explicit truncation match (dangling word/mid-word cut)
  if (f.code === "fidelity") return true; // explicit, exact substring mismatch against the claimed source
  if (f.code === "encoding") return f.reason.includes("BUG-046"); // narrow ³/¿-next-to-Cyrillic signature only
  return false;
}

/**
 * ADR-034 § 1b: no dedicated "this book has known extraction defects" flag
 * exists on `materials` yet (ADR-034 calls that a future, optional field for
 * the parent's book page — out of scope here). Until it exists, match by
 * name/title against the one confirmed book from BUG-046
 * ("6-klas-zarlit-kovbasenko-2023.pdf", "Зарубіжна література"). Extend this
 * list — do not replace the mechanism — as further extraction defects get
 * confirmed against specific books.
 */
export const KNOWN_DEFECTIVE_BOOK_PATTERNS: RegExp[] = [/zarlit/i, /kovbasenko/i, /зарубіжн\p{L}*\s+літератур/iu];

export function matchesKnownDefectiveBook(name: string | null, title: string | null): boolean {
  const haystacks = [name, title].filter((v): v is string => !!v);
  return haystacks.some((h) => KNOWN_DEFECTIVE_BOOK_PATTERNS.some((re) => re.test(h)));
}
