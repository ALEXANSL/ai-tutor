/**
 * S33 follow-up (PO decision 2026-09-30, "готую курси сам через ChatGPT/Claude,
 * навіщо повторно платити за генерацію") — a ONE-TIME, MANUAL ops script,
 * same spirit as `run-literature-extraction.ts` but $0 / no AI call: reads
 * an already-unzipped course directory in the PO's own reference format
 * (`README.md`, `course_index.json`, `lessons/NN.md`, `tests/NN.json`) from
 * local disk and imports it straight into `literature_lessons`/
 * `literature_lesson_tests` via the pure `literatureImport.ts` parser +
 * the same `persistLiteratureTopic` the AI-extraction path uses.
 *
 * Usage (from app/):
 *   npx tsx --conditions=react-server scripts/import-literature-course.ts \
 *     --dir <path to unzipped course folder> \
 *     --material <materials.id> --subject <subjects.id> [--family <families.id>]
 *
 * Same env vars as `run-literature-extraction.ts` (Supabase only — no AI
 * provider key is needed for this path).
 */
import "server-only";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { forFamily } from "../src/server/db/family-scope";
import { persistLiteratureTopic } from "../src/server/lessons/literatureExtraction";
import { parseLiteratureCourseZip } from "../src/server/lessons/literatureImport";
import { createServiceClient } from "../src/server/supabase/clients";

const args = process.argv.slice(2);
function argVal(name: string): string | null {
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]!;
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.split("=").slice(1).join("=") : null;
}

const COURSE_DIR = argVal("dir");
const MATERIAL_ID = argVal("material");
const SUBJECT_ID = argVal("subject");

/** Reads an unzipped course folder off disk and re-zips it in memory — `literatureImport.ts`'s parser only ever works on zip bytes, so both the admin-UI upload and this CLI script go through the exact same code path. */
function zipCourseDirectory(dir: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (f === "lessons" || f === "tests") {
      for (const sub of readdirSync(full)) files[`${f}/${sub}`] = new Uint8Array(readFileSync(join(full, sub)));
    } else if (f.endsWith(".md") || f.endsWith(".json")) {
      files[f] = new Uint8Array(readFileSync(full));
    }
  }
  return zipSync(files);
}

async function main() {
  if (!COURSE_DIR || !MATERIAL_ID || !SUBJECT_ID) {
    console.error("Usage: import-literature-course --dir <course folder> --material <materials.id> --subject <subjects.id> [--family <families.id>]");
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

  const { data: subject } = await client.from("subjects").select("name_uk").eq("id", SUBJECT_ID).single<{ name_uk: string }>();

  console.warn(`Parsing course directory "${COURSE_DIR}"...`);
  const { topics, warnings } = parseLiteratureCourseZip(zipCourseDirectory(COURSE_DIR));
  console.warn(`Parsed ${topics.length} topic(s), ${warnings.length} warning(s).`);
  for (const w of warnings) console.warn(`  [topic ${w.topicNo ?? "-"}] ${w.field}: ${w.message}`);

  if (topics.length === 0) {
    console.error("No topics parsed — nothing to import.");
    process.exit(1);
  }

  const scope = forFamily(familyId, client);
  console.warn(`Importing into "${material.title ?? material.name}" (${MATERIAL_ID}), subject "${subject?.name_uk ?? SUBJECT_ID}"...`);

  let sortOrder = 0;
  let active = 0;
  let needsReview = 0;
  for (const topic of topics.sort((a, b) => a.topicNo - b.topicNo)) {
    sortOrder += 1;
    const saved = await persistLiteratureTopic(scope, { subjectId: SUBJECT_ID, materialId: MATERIAL_ID, grade: material.grade }, topic, sortOrder, "manual_import", null);
    if (saved.status === "active") active += 1;
    else needsReview += 1;
    console.warn(`  Тема ${saved.topicNo}: ${saved.status}${saved.failures.length > 0 ? ` (${saved.failures.length} content_qa зауваж.)` : ""}`);
  }

  console.warn(`Done. ${topics.length} topics saved — active: ${active}, needs_review: ${needsReview}. Cost: $0 (no AI call).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
