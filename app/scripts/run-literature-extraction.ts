/**
 * S33 (PO decision 2026-09-30, corrected same day) — a ONE-TIME, MANUAL ops
 * script. Runs the new `literature_extraction` path (see
 * `src/server/lessons/literatureExtraction.ts`'s module doc) against ONE
 * already-indexed book (`materials.status = 'ready'`) and saves the result
 * into `literature_lessons`/`literature_lesson_tests`.
 *
 * This is NOT part of the live request pipeline and does NOT run on a
 * schedule. It exists so the new path can be demonstrated today (S33's
 * scope: make it work for one subject/book, not a background-job queue
 * integration — that is a natural follow-up once this path is validated by
 * the PO against his own reference examples).
 *
 * Usage (from app/):
 *   npx tsx --conditions=react-server scripts/run-literature-extraction.ts \
 *     --material <materials.id> --subject <subjects.id> [--family <families.id>]
 *
 * `--family` is optional when the material row is unambiguous (looked up
 * directly by id — every table here is family-scoped, so the script reads
 * the material first to learn its own `owner_family_id`).
 *
 * Requires the same env vars any server script needs: NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, and the AI
 * provider key(s) configured for the `literature_extraction` model route
 * (Claude Opus 5.5 by default — ANTHROPIC_API_KEY).
 */
import "server-only";
import { forFamily } from "../src/server/db/family-scope";
import { runLiteratureExtraction } from "../src/server/lessons/literatureExtraction";
import { createServiceClient } from "../src/server/supabase/clients";

const args = process.argv.slice(2);
function argVal(name: string): string | null {
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]!;
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.split("=").slice(1).join("=") : null;
}

const MATERIAL_ID = argVal("material");
const SUBJECT_ID = argVal("subject");

async function main() {
  if (!MATERIAL_ID || !SUBJECT_ID) {
    console.error("Usage: run-literature-extraction --material <materials.id> --subject <subjects.id> [--family <families.id>]");
    process.exit(1);
  }

  const client = createServiceClient();
  const { data: material, error } = await client
    .from("materials")
    .select("id, owner_family_id, title, name, grade")
    .eq("id", MATERIAL_ID)
    .single<{ id: string; owner_family_id: string; title: string | null; name: string; grade: number | null }>();
  if (error || !material) {
    console.error(`Material ${MATERIAL_ID} not found: ${error?.message ?? "no row"}`);
    process.exit(1);
  }

  const familyId = argVal("family") ?? material.owner_family_id;
  if (!familyId) {
    console.error("Could not determine family_id — pass --family explicitly.");
    process.exit(1);
  }

  const { data: subject } = await client.from("subjects").select("name").eq("id", SUBJECT_ID).single<{ name: string }>();

  const scope = forFamily(familyId, client);
  console.warn(`Extracting "${material.title ?? material.name}" (${MATERIAL_ID}) for subject "${subject?.name ?? SUBJECT_ID}"...`);

  const result = await runLiteratureExtraction(scope, {
    familyId,
    subjectId: SUBJECT_ID,
    materialId: MATERIAL_ID,
    materialTitle: material.title ?? material.name,
    subjectName: subject?.name ?? "",
    grade: material.grade,
  });

  console.warn(`\n=== literature_extraction — summary ===`);
  console.warn(`Book sections grouped into ${result.groups} AI call(s).`);
  console.warn(`Topics saved: ${result.topics.length}`);
  const active = result.topics.filter((t) => t.status === "active").length;
  const needsReview = result.topics.length - active;
  console.warn(`  active: ${active}   needs_review (content_qa failed): ${needsReview}`);
  for (const t of result.topics) {
    console.warn(`  - Тема ${t.topicNo}: ${t.status}${t.failures.length ? ` (${t.failures.length} content_qa failure(s))` : ""}`);
  }
  if (result.driveWriteFailures.length) {
    console.warn(`\nWork full-text Drive writes that failed (lesson still saved, just without a full-text file — check Google Drive connection):`);
    for (const f of result.driveWriteFailures) console.warn(`  - Тема ${f.topicNo}: ${f.reason}`);
  }
  const totalCost = result.calls.reduce((sum, c) => sum + c.costUsd, 0);
  console.warn(`\nAI calls: ${result.calls.length}, total cost: $${totalCost.toFixed(4)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
