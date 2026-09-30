/**
 * ADR-034 § "Ретроактивний sweep" — a ONE-TIME, MANUAL ops script.
 *
 * This is NOT part of the live request pipeline and does NOT run on a
 * schedule (no pg_cron, no server route calls it). It is meant to be run by
 * hand (a developer) against the production DB whenever they choose to,
 * exactly once per "we changed content_qa's rules, let's re-scan the
 * already-cached library" occasion.
 *
 * All the DB orchestration (targeting, running the checks, writing,
 * building the summary) lives in `content-qa-sweep-lib.ts`'s
 * `runContentQaSweep` — this file is now only CLI-arg parsing and printing.
 * The same function is called by the parent cabinet's
 * "Перевірити бібліотеку уроків" button (`app/src/app/actions/content-qa-sweep.ts`,
 * for the non-technical PO — he cannot run a terminal command), so the two
 * entry points can never drift apart.
 *
 * What it does (ADR-034, all three points) — see `runContentQaSweep`'s own
 * doc comment for the full targeting/checks/write write-up:
 *   1. Targets `library_items` (kind='block') in priority order: (a)
 *      status='fallback' (BUG-011 marker, highest risk), (b) active items on
 *      a known-defective book (BUG-046), (c) the rest of active, most-
 *      recently-shown-to-the-child first.
 *   2. Runs the exact same deterministic checks already built and unit-
 *      tested this session (`checkStepContentQa`/`checkVerbatimFidelity`).
 *   3. On failure: writes `library_items.content_qa` (never auto-deletes
 *      anything); only the clearest, highest-confidence failure classes
 *      auto-transition `status -> 'needs_review'`.
 *   4. Prints ONE summary at the end — never one notification/line per item.
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
import { runContentQaSweep, type ContentQaSweepSummary } from "../src/server/lessons/content-qa-sweep-lib";
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

function printSummary(summary: ContentQaSweepSummary): void {
  console.warn(
    `Targets: ${summary.targetCounts.total} (fallback: ${summary.targetCounts.fallback}, known-defect-book: ${summary.targetCounts.knownDefectBook}, rest active: ${summary.targetCounts.restActive}${
      LIMIT ? `, capped to ${LIMIT}` : ""
    })`,
  );
  if (summary.noKnownDefectBookMatch) {
    console.warn("Note: no material matched KNOWN_DEFECTIVE_BOOK_PATTERNS in this DB — category (b) is empty this run.");
  }

  console.warn("\n=== content_qa retroactive sweep — summary ===");
  console.warn(`Mode: ${summary.mode === "apply" ? "APPLY (DB written)" : "DRY RUN (nothing written — re-run with --apply)"}`);
  console.warn(`Checked: ${summary.totals.checked}   Flagged: ${summary.totals.flagged}   Auto-transitioned to needs_review: ${summary.totals.autoTransitioned}`);
  console.warn("By category:");
  for (const [cat, c] of Object.entries(summary.counts)) {
    console.warn(`  ${cat.padEnd(20)} checked=${c.checked}  flagged=${c.flagged}  auto-transitioned=${c.autoTransitioned}`);
  }
  if (summary.flaggedDetails.length > 0) {
    console.warn("\nFlagged items:");
    for (const d of summary.flaggedDetails) {
      console.warn(`  [${d.category}] ${d.id}${d.autoTransitioned ? " (auto -> needs_review)" : " (flagged only, still visible — needs a human look)"}`);
      for (const f of d.failures) console.warn(`      - ${f}`);
    }
  }
  console.warn("\nDone. This script does not run on a schedule — nothing else happens until it is run again by hand.");
}

async function main() {
  const client = createServiceClient();
  console.warn(`content_qa retroactive sweep — ${new Date().toISOString()} — mode: ${APPLY ? "APPLY (writes DB)" : "DRY RUN (no writes)"}`);
  if (FAMILY_FILTER) console.warn(`Scoped to family: ${FAMILY_FILTER}`);
  if (LIMIT) console.warn(`Limit: ${LIMIT} items`);

  const summary = await runContentQaSweep(client, { apply: APPLY, limit: LIMIT, familyId: FAMILY_FILTER });
  printSummary(summary);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
