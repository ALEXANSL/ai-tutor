/**
 * ADR-034 § "Ретроактивний sweep" — a ONE-TIME, MANUAL ops script.
 *
 * This is NOT part of the live request pipeline and does NOT run on a
 * schedule (no pg_cron, no server route calls it). It is meant to be run by
 * hand (the PO or a developer) against the production DB whenever they
 * choose to, exactly once per "we changed content_qa's rules, let's re-scan
 * the already-cached library" occasion.
 *
 * What it does (ADR-034, all three points):
 *   1. Targets `library_items` (kind='block' only — the only kind whose
 *      steps match the `GeneratedStep` shape `content-qa.ts` checks) in
 *      priority order:
 *        a. status = 'fallback'      (BUG-011 marker, highest risk)
 *        b. status = 'active' whose topic's book (or a cited source_ref's
 *           book) matches a KNOWN, already-confirmed extraction-defect book
 *           (BUG-046) — see `content-qa-sweep-lib.ts`'s
 *           `KNOWN_DEFECTIVE_BOOK_PATTERNS`; no dedicated "this book has
 *           known extraction issues" flag exists on `materials` yet
 *           (ADR-034 flags that as a *future*, optional field for the
 *           parent's book page — not built here), so this is a name/title
 *           match against the one book BUG-046 identified, kept as a short,
 *           documented, extensible list rather than a single hard-coded id.
 *        c. the rest of `active`, ordered by most-recently-shown-to-the-
 *           child first (`session_blocks.created_at` — the moment
 *           `activateBlock`, orchestrator.ts, actually puts a block in front
 *           of the child), never-shown items last.
 *   2. Runs the EXACT SAME deterministic checks already built and unit-
 *      tested this session (`checkStepContentQa` / `checkVerbatimFidelity`,
 *      `app/src/server/lessons/content-qa.ts`, reused via
 *      `content-qa-sweep-lib.ts` — no duplicated rule logic) against each
 *      targeted item's saved `library_steps`.
 *   3. On failure: writes `library_items.content_qa` (never auto-deletes
 *      anything). Only the CLEAREST, highest-confidence failure classes
 *      (`isHighConfidenceFailure` — completeness, verbatim-fidelity
 *      mismatch, or the narrow BUG-046 encoding signature; NOT the generic
 *      character-density encoding threshold) auto-transition
 *      `status -> 'needs_review'` (`needs_review_reason = 'technical'`).
 *   4. Prints ONE summary at the end (counts per category + flagged/auto-
 *      transitioned totals) — never one notification/line per item.
 *
 * $0 cost: no AI call anywhere in this file.
 *
 * Usage (from app/):
 *   # Dry run (default) — checks everything, prints the summary, writes NOTHING:
 *   npm run content-qa:sweep
 *
 *   # Actually writes `library_items.content_qa` (and, for high-confidence
 *   # failures, `status`/`needs_review_reason`) and inserts the matching
 *   # `library_item_reviews` audit rows:
 *   npm run content-qa:sweep -- --apply
 *
 *   # Optional safety valves while testing against a real DB:
 *   npm run content-qa:sweep -- --apply --limit 20
 *   npm run content-qa:sweep -- --family <uuid>
 *
 * Requires the same env vars any server script needs: NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */
import "server-only";
import { checkItemSteps, isHighConfidenceFailure, matchesKnownDefectiveBook, type RawStepRow } from "../src/server/lessons/content-qa-sweep-lib";
import { createServiceClient } from "../src/server/supabase/clients";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const limitArg = args.find((a) => a.startsWith("--limit"));
const LIMIT = limitArg ? Number(limitArg.includes("=") ? limitArg.split("=")[1] : args[args.indexOf(limitArg) + 1]) : null;
const familyArg = args.find((a) => a.startsWith("--family"));
const FAMILY_FILTER = familyArg ? (familyArg.includes("=") ? familyArg.split("=")[1] : args[args.indexOf(familyArg) + 1]) : null;

type Category = "fallback" | "known_defect_book" | "rest_active";
type Row = { id: string; owner_family_id: string | null; status: string; topic_id: string; source_refs: { materialId: string }[] };

async function main() {
  const client = createServiceClient();
  console.warn(`content_qa retroactive sweep — ${new Date().toISOString()} — mode: ${APPLY ? "APPLY (writes DB)" : "DRY RUN (no writes)"}`);
  if (FAMILY_FILTER) console.warn(`Scoped to family: ${FAMILY_FILTER}`);
  if (LIMIT) console.warn(`Limit: ${LIMIT} items`);

  // --- (a) status = 'fallback' ------------------------------------------------
  let fallbackQuery = client.from("library_items").select("id, owner_family_id, status, topic_id, source_refs").eq("kind", "block").eq("status", "fallback");
  if (FAMILY_FILTER) fallbackQuery = fallbackQuery.eq("owner_family_id", FAMILY_FILTER);
  const { data: fallbackRows, error: fallbackErr } = await fallbackQuery.returns<Row[]>();
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
  const { data: activeRows, error: activeErr } = await activeQuery.returns<Row[]>();
  if (activeErr) throw new Error(`loading active items failed: ${activeErr.message}`);

  const fallbackIds = new Set((fallbackRows ?? []).map((r) => r.id));
  const isKnownDefectBook = (r: Row): boolean =>
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

  const targets: { row: Row; category: Category }[] = [
    ...(fallbackRows ?? []).map((row) => ({ row, category: "fallback" as Category })),
    ...knownDefectRows.map((row) => ({ row, category: "known_defect_book" as Category })),
    ...restRows.map((row) => ({ row, category: "rest_active" as Category })),
  ].slice(0, LIMIT ?? Infinity);

  console.warn(
    `Targets: ${targets.length} (fallback: ${(fallbackRows ?? []).length}, known-defect-book: ${knownDefectRows.length}, rest active: ${restRows.length}${LIMIT ? `, capped to ${LIMIT}` : ""})`,
  );
  if (knownDefectMaterialIds.size === 0) {
    console.warn("Note: no material matched KNOWN_DEFECTIVE_BOOK_PATTERNS in this DB — category (b) is empty this run.");
  }

  // --- run the checks -----------------------------------------------------
  const counts = {
    fallback: { checked: 0, flagged: 0, autoTransitioned: 0 },
    known_defect_book: { checked: 0, flagged: 0, autoTransitioned: 0 },
    rest_active: { checked: 0, flagged: 0, autoTransitioned: 0 },
  };
  const flaggedDetails: { id: string; category: Category; failures: string[]; autoTransitioned: boolean }[] = [];

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

  // --- one summary, never one notification per item ------------------------
  const totalChecked = counts.fallback.checked + counts.known_defect_book.checked + counts.rest_active.checked;
  const totalFlagged = counts.fallback.flagged + counts.known_defect_book.flagged + counts.rest_active.flagged;
  const totalAuto = counts.fallback.autoTransitioned + counts.known_defect_book.autoTransitioned + counts.rest_active.autoTransitioned;

  console.warn("\n=== content_qa retroactive sweep — summary ===");
  console.warn(`Mode: ${APPLY ? "APPLY (DB written)" : "DRY RUN (nothing written — re-run with --apply)"}`);
  console.warn(`Checked: ${totalChecked}   Flagged: ${totalFlagged}   Auto-transitioned to needs_review: ${totalAuto}`);
  console.warn("By category:");
  for (const [cat, c] of Object.entries(counts)) {
    console.warn(`  ${cat.padEnd(20)} checked=${c.checked}  flagged=${c.flagged}  auto-transitioned=${c.autoTransitioned}`);
  }
  if (flaggedDetails.length > 0) {
    console.warn("\nFlagged items:");
    for (const d of flaggedDetails) {
      console.warn(`  [${d.category}] ${d.id}${d.autoTransitioned ? " (auto -> needs_review)" : " (flagged only, still visible — needs a human look)"}`);
      for (const f of d.failures) console.warn(`      - ${f}`);
    }
  }
  console.warn("\nDone. This script does not run on a schedule — nothing else happens until it is run again by hand.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
