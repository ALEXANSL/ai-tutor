import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { checkStepContentQa, checkVerbatimFidelity, type ContentQaFailure } from "./content-qa";
import type { GeneratedStep } from "./schema";

/**
 * ADR-034 § "Ретроактивний sweep" — the pure/testable pieces of the sweep
 * (reconstructing a saved `library_steps` row into the `GeneratedStep` shape
 * `content-qa.ts` already checks, deciding which failures are high-confidence
 * enough to auto-transition a block to `needs_review`, and the BUG-046
 * known-defect-book name match), plus `runContentQaSweep` — the full DB
 * orchestration (targeting, running the checks, writing, building one
 * summary) shared by BOTH callers so neither duplicates it:
 *  - `scripts/content-qa-sweep.ts` (the original one-time CLI, service-role
 *    env vars, run by hand against prod by a developer);
 *  - `runContentQaSweepAction` (`app/src/app/actions/content-qa-sweep.ts`,
 *    S40-follow-up "Перевірити бібліотеку уроків" button in the parent
 *    cabinet's «Налаштування» → «Обслуговування» — same sweep, same
 *    dry-run-by-default safety, just triggered by a click instead of a
 *    terminal command, for the non-technical PO).
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
  if (f.code === "figure_reference") return true; // explicit ◄...► technical marker match, no ambiguity
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

// ---------------------------------------------------------------------------
// Full DB orchestration (targeting, running, writing, one summary) — shared
// by the CLI script and the parent-cabinet server action. See ADR-034 §
// "Ретроактивний sweep" for the targeting-order rationale (a/b/c below).
// ---------------------------------------------------------------------------

export type SweepCategory = "fallback" | "known_defect_book" | "rest_active";

interface SweepRow {
  id: string;
  owner_family_id: string | null;
  status: string;
  topic_id: string;
  source_refs: { materialId: string }[];
}

export interface SweepCategoryCounts {
  checked: number;
  flagged: number;
  autoTransitioned: number;
}

export interface SweepFlaggedDetail {
  id: string;
  category: SweepCategory;
  failures: string[];
  autoTransitioned: boolean;
}

export interface SweepTargetCounts {
  fallback: number;
  knownDefectBook: number;
  restActive: number;
  total: number;
  /** Capped by `opts.limit`, if any — `total` before the cap. */
  totalBeforeLimit: number;
}

export interface ContentQaSweepSummary {
  mode: "dry_run" | "apply";
  ranAt: string;
  familyFilter: string | null;
  limit: number | null;
  targetCounts: SweepTargetCounts;
  counts: Record<SweepCategory, SweepCategoryCounts>;
  totals: { checked: number; flagged: number; autoTransitioned: number };
  flaggedDetails: SweepFlaggedDetail[];
  /** No material in this DB matched `KNOWN_DEFECTIVE_BOOK_PATTERNS` this run. */
  noKnownDefectBookMatch: boolean;
}

export interface ContentQaSweepOptions {
  /** `false` (default): checks everything, writes nothing (matches the CLI's own `--apply`-required-to-write default). */
  apply: boolean;
  limit?: number | null;
  familyId?: string | null;
}

/**
 * Runs the full ADR-034 retroactive sweep against a real Supabase client:
 * targets `library_items` (kind='block') in priority order — (a) `fallback`
 * status, (b) `active` items on a known-defective book (BUG-046), (c) the
 * rest of `active`, most-recently-shown-to-the-child first — runs the exact
 * same deterministic checks (`checkItemSteps`, above) against each one's
 * saved `library_steps`, and on `apply: true` writes `library_items.content_qa`
 * (+ `status`/`needs_review_reason` for high-confidence failures, + a
 * `library_item_reviews` audit row) exactly as `checkStepContentQa`'s own
 * live pipeline would. Never throws for a single item's failure (logs and
 * skips it) — only for a failure loading the target lists themselves.
 */
export async function runContentQaSweep(client: SupabaseClient, opts: ContentQaSweepOptions): Promise<ContentQaSweepSummary> {
  const APPLY = opts.apply;
  const LIMIT = opts.limit ?? null;
  const FAMILY_FILTER = opts.familyId ?? null;

  // --- (a) status = 'fallback' ------------------------------------------------
  let fallbackQuery = client.from("library_items").select("id, owner_family_id, status, topic_id, source_refs").eq("kind", "block").eq("status", "fallback");
  if (FAMILY_FILTER) fallbackQuery = fallbackQuery.eq("owner_family_id", FAMILY_FILTER);
  const { data: fallbackRows, error: fallbackErr } = await fallbackQuery.returns<SweepRow[]>();
  if (fallbackErr) throw new Error(`loading fallback items failed: ${fallbackErr.message}`);

  // --- (b) known-defect-book active items --------------------------------------
  const { data: materialRows, error: materialErr } = await client.from("materials").select("id, name, title").returns<{ id: string; name: string; title: string | null }[]>();
  if (materialErr) throw new Error(`loading materials failed: ${materialErr.message}`);
  const knownDefectMaterialIds = new Set((materialRows ?? []).filter((m) => matchesKnownDefectiveBook(m.name, m.title)).map((m) => m.id));

  const { data: knownDefectTopicRows } = knownDefectMaterialIds.size
    ? await client.from("topics").select("id, material_id").in("material_id", [...knownDefectMaterialIds]).returns<{ id: string; material_id: string }[]>()
    : { data: [] as { id: string; material_id: string }[] };
  const knownDefectTopicIds = new Set((knownDefectTopicRows ?? []).map((t) => t.id));

  let activeQuery = client.from("library_items").select("id, owner_family_id, status, topic_id, source_refs").eq("kind", "block").eq("status", "active");
  if (FAMILY_FILTER) activeQuery = activeQuery.eq("owner_family_id", FAMILY_FILTER);
  const { data: activeRows, error: activeErr } = await activeQuery.returns<SweepRow[]>();
  if (activeErr) throw new Error(`loading active items failed: ${activeErr.message}`);

  const fallbackIds = new Set((fallbackRows ?? []).map((r) => r.id));
  const isKnownDefectBook = (r: SweepRow): boolean =>
    knownDefectTopicIds.has(r.topic_id) || (r.source_refs ?? []).some((sr) => knownDefectMaterialIds.has(sr.materialId));
  const knownDefectRows = (activeRows ?? []).filter((r) => !fallbackIds.has(r.id) && isKnownDefectBook(r));
  const knownDefectIds = new Set(knownDefectRows.map((r) => r.id));

  // --- (c) rest of active, ordered by most-recently-shown-to-the-child first --
  const restRows = (activeRows ?? []).filter((r) => !fallbackIds.has(r.id) && !knownDefectIds.has(r.id));
  const { data: shownRows } = restRows.length
    ? await client.from("session_blocks").select("library_item_id, created_at").in("library_item_id", restRows.map((r) => r.id)).returns<{ library_item_id: string; created_at: string }[]>()
    : { data: [] as { library_item_id: string; created_at: string }[] };
  const lastShownByItem = new Map<string, string>();
  for (const s of shownRows ?? []) {
    const prev = lastShownByItem.get(s.library_item_id);
    if (!prev || s.created_at > prev) lastShownByItem.set(s.library_item_id, s.created_at);
  }
  restRows.sort((a, b) => {
    const ta = lastShownByItem.get(a.id);
    const tb = lastShownByItem.get(b.id);
    if (ta && tb) return tb.localeCompare(ta); // descending — most recently shown first
    if (ta && !tb) return -1; // ever-shown before never-shown
    if (!ta && tb) return 1;
    return 0;
  });

  const allTargets: { row: SweepRow; category: SweepCategory }[] = [
    ...(fallbackRows ?? []).map((row) => ({ row, category: "fallback" as SweepCategory })),
    ...knownDefectRows.map((row) => ({ row, category: "known_defect_book" as SweepCategory })),
    ...restRows.map((row) => ({ row, category: "rest_active" as SweepCategory })),
  ];
  const targets = allTargets.slice(0, LIMIT ?? Infinity);

  // --- run the checks -----------------------------------------------------
  const counts: Record<SweepCategory, SweepCategoryCounts> = {
    fallback: { checked: 0, flagged: 0, autoTransitioned: 0 },
    known_defect_book: { checked: 0, flagged: 0, autoTransitioned: 0 },
    rest_active: { checked: 0, flagged: 0, autoTransitioned: 0 },
  };
  const flaggedDetails: SweepFlaggedDetail[] = [];

  const lookupChunkText = async (materialId: string, page: number): Promise<string | null> => {
    const { data } = await client.from("chunks").select("text").eq("material_id", materialId).eq("page", page).limit(1).maybeSingle<{ text: string }>();
    return data?.text ?? null;
  };

  for (const { row, category } of targets) {
    const { data: stepRows, error: stepsErr } = await client
      .from("library_steps")
      .select("id, sort_order, type, content, visual, source_refs")
      .eq("item_id", row.id)
      .order("sort_order", { ascending: true })
      .returns<RawStepRow[]>();
    if (stepsErr) {
      console.error(`skipping ${row.id}: loading steps failed: ${stepsErr.message}`);
      continue;
    }

    const { failures } = await checkItemSteps(stepRows ?? [], lookupChunkText);
    counts[category].checked++;

    const checkedAt = new Date().toISOString();
    const contentQaValue = { status: failures.length === 0 ? "checked_ok" : "flagged", failures, checkedAt };

    if (failures.length === 0) {
      if (APPLY) {
        const { error } = await client.from("library_items").update({ content_qa: contentQaValue }).eq("id", row.id);
        if (error) console.error(`writing checked_ok content_qa for ${row.id} failed: ${error.message}`);
      }
      continue;
    }

    counts[category].flagged++;
    const highConfidence = failures.some(isHighConfidenceFailure);
    if (highConfidence) counts[category].autoTransitioned++;
    flaggedDetails.push({ id: row.id, category, failures: failures.map((f) => `${f.field}: ${f.reason}`), autoTransitioned: highConfidence });

    if (!APPLY) continue;

    const update: Record<string, unknown> = { content_qa: contentQaValue };
    if (highConfidence) {
      update.status = "needs_review";
      update.needs_review_reason = "technical";
    }
    const { error: updateErr } = await client.from("library_items").update(update).eq("id", row.id);
    if (updateErr) {
      console.error(`writing flagged content_qa for ${row.id} failed: ${updateErr.message}`);
      continue;
    }

    const { data: lastReview } = await client
      .from("library_item_reviews")
      .select("iteration")
      .eq("library_item_id", row.id)
      .order("iteration", { ascending: false })
      .limit(1)
      .maybeSingle<{ iteration: number }>();
    const { error: reviewErr } = await client.from("library_item_reviews").insert({
      owner_family_id: row.owner_family_id,
      library_item_id: row.id,
      iteration: (lastReview?.iteration ?? 0) + 1,
      reviewer_role: "content_qa",
      provider: "deterministic",
      model: "rule-based-v1",
      verdict: highConfidence ? "rejected" : "revise",
      scores: {},
      notes: `Ретроактивний content_qa sweep (${new Date().toISOString().slice(0, 10)}):\n${failures.map((f) => `- ${f.field}: ${f.reason}`).join("\n")}`,
    });
    if (reviewErr) console.error(`writing library_item_reviews audit row for ${row.id} failed: ${reviewErr.message}`);
  }

  const totalChecked = counts.fallback.checked + counts.known_defect_book.checked + counts.rest_active.checked;
  const totalFlagged = counts.fallback.flagged + counts.known_defect_book.flagged + counts.rest_active.flagged;
  const totalAuto = counts.fallback.autoTransitioned + counts.known_defect_book.autoTransitioned + counts.rest_active.autoTransitioned;

  return {
    mode: APPLY ? "apply" : "dry_run",
    ranAt: new Date().toISOString(),
    familyFilter: FAMILY_FILTER,
    limit: LIMIT,
    targetCounts: {
      fallback: (fallbackRows ?? []).length,
      knownDefectBook: knownDefectRows.length,
      restActive: restRows.length,
      total: targets.length,
      totalBeforeLimit: allTargets.length,
    },
    counts,
    totals: { checked: totalChecked, flagged: totalFlagged, autoTransitioned: totalAuto },
    flaggedDetails,
    noKnownDefectBookMatch: knownDefectMaterialIds.size === 0,
  };
}
