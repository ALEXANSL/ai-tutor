/**
 * ADR-036 recommendation #2 ("Вартість-1", PO-approved 2026-09-30) — a
 * ONE-TIME, MANUAL A/B comparison script. NOT part of the live pipeline, does
 * NOT run on a schedule, and does NOT change any production routing:
 * `model_routes.primary_model` for `indexing_structure` stays on
 * Claude Opus 5.5 until/unless the PO makes an explicit permanent decision
 * after reading this script's report.
 *
 * What it does:
 *   For 2-3 already-indexed sections (real book sections, picked either
 *   automatically — preferring the structurally-dense books that caused the
 *   ADR-032 production incident — or explicitly via --section <uuid>), it
 *   builds the EXACT SAME `indexing_structure` prompt the production
 *   pipeline builds (`buildSectionText`/`fillTemplate`/`sectionPrompt`,
 *   mirroring `runStructureSection` in `app/src/server/ingest/pipeline.ts`
 *   field-for-field) and sends it to BOTH:
 *     - Claude Opus 5.5 (`claude-opus-5-5`) — today's production model, and
 *     - Claude Sonnet 5 (`claude-sonnet-5`) — the candidate.
 *   using the SAME route params (`max_tokens`, `effort`, `timeout_ms`) the
 *   production `indexing_structure` route uses.
 *
 * It calls `anthropicStructured` DIRECTLY (not `callStructured`/the router):
 * this is a deliberate, one-off side-by-side comparison, not a routed
 * production call, so it does NOT write to `ai_calls`, does NOT count
 * against the family's monthly AI budget, and does NOT touch
 * `model_routes` — see CLAUDE.md "Маршрутизацію моделей реалізуй через
 * таблицю налаштувань, а не жорстко в коді", which governs how PRODUCTION
 * code picks a model, not this standalone manual comparison tool. Cost per
 * call is still computed with the exact same `estimateCostUsd` pricing logic
 * production uses, reading live prices from `model_prices`.
 *
 * It writes NOTHING to the database — read-only against `materials` /
 * `material_sections` / `chunks` / `topics`, and prints one JSON (or
 * markdown, with --format=md) report to stdout for a human (PO or
 * product-manager) to eyeball, especially exercise-number recognition
 * (ADR-029) and section-boundary accuracy (ADR-032/036's specific risk for
 * structurally-dense books).
 *
 * Usage (from app/), after the PO explicitly decides to spend the "кілька
 * центів" this costs:
 *
 *   # Auto-pick up to 3 already-ready sections, preferring the
 *   # structurally-dense ADR-032 incident books if any are in this DB:
 *   npm run ab:indexing-structure
 *
 *   # Compare specific sections instead (repeat --section as needed):
 *   npm run ab:indexing-structure -- --section <material_sections.id> --section <another id>
 *
 *   # Or every ready section of one material (capped by --limit, default 3):
 *   npm run ab:indexing-structure -- --material <materials.id> --limit 2
 *
 *   # Markdown table instead of JSON:
 *   npm run ab:indexing-structure -- --format=md
 *
 * Requires the same env vars any server script needs (NEXT_PUBLIC_SUPABASE_URL,
 * NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY) plus
 * ANTHROPIC_API_KEY. Server-only — never run this from client code, and never
 * commit its output if it ever contains verbatim book text (it may, since
 * this reuses `buildSectionText`'s full section text as the prompt input).
 */
import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceTypes } from "@/core/registries/learning";
import { anthropicStructured } from "../src/server/ai/providers/anthropic";
import { estimateCostUsd } from "../src/server/ai/policy";
import { loadPrice } from "../src/server/ai/store";
import type { RouteParams, Usage } from "../src/server/ai/types";
import { buildSectionSchema, buildSectionText, fillTemplate, splitPrompt, type PageText, type SectionAnswer } from "../src/server/ingest/structure";
import { createServiceClient } from "../src/server/supabase/clients";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function collect(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === flag) out.push(args[++i]!);
    else if (a.startsWith(`${flag}=`)) out.push(a.slice(flag.length + 1));
  }
  return out;
}
const SECTION_IDS = collect("--section");
const MATERIAL_IDS = collect("--material");
const limitArg = args.find((a) => a === "--limit" || a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.includes("=") ? limitArg.split("=")[1] : args[args.indexOf(limitArg) + 1]) : 3;
const FORMAT = args.includes("--format=md") ? "md" : "json";

// The two models under comparison — same provider (Anthropic), same route
// params (below), different model id only.
const OPUS: ModelId = { label: "opus-5-5 (production)", model: "claude-opus-5-5" };
const SONNET: ModelId = { label: "sonnet-5 (candidate)", model: "claude-sonnet-5" };
interface ModelId {
  label: string;
  model: string;
}

// Same route params the seeded `indexing_structure` route uses
// (`supabase/migrations/20260926100000_s1_ai_router_costs_jobs.sql`) — kept
// identical between both calls so the ONLY variable under test is the model.
const PARAMS: RouteParams = { max_tokens: 32000, effort: "medium", timeout_ms: 240_000 };

// ADR-032/036's own examples of the structurally-dense books that caused the
// production incident this A/B test is meant to de-risk (deep §-rubrication
// and/or hundreds of numbered exercises) — title/name substrings, matched
// case-insensitively, same spirit as content-qa-sweep-lib's
// KNOWN_DEFECTIVE_BOOK_PATTERNS. Auto-pick prefers materials matching these
// when no explicit --section/--material is given.
const DENSE_BOOK_PATTERNS = [/історія.*6.*клас/iu, /щупак/iu, /українська мова/iu, /семеног/iu, /українська література/iu, /калинич/iu];

type SectionRow = {
  id: string;
  material_id: string;
  title: string;
  page_from: number | null;
  page_to: number | null;
  sort_order: number;
  status: string;
};
type MaterialRow = {
  id: string;
  name: string;
  title: string | null;
  kind: string;
  grade: number | null;
  curriculum_version: string | null;
  subject_id: string | null;
  page_count: number | null;
};

let sectionPromptCache: { system: string; user: string } | null = null;
function sectionPrompt(): { system: string; user: string } {
  // Same file, same split logic `runStructureSection` uses — read from
  // app/prompts (this script also runs from app/, same as `npm run`).
  sectionPromptCache ??= splitPrompt(readFileSync(join(process.cwd(), "prompts", "indexing_structure.md"), "utf8"));
  return sectionPromptCache;
}

async function pickSections(client: ReturnType<typeof createServiceClient>): Promise<SectionRow[]> {
  if (SECTION_IDS.length) {
    const { data, error } = await client
      .from("material_sections")
      .select("id, material_id, title, page_from, page_to, sort_order, status")
      .in("id", SECTION_IDS)
      .returns<SectionRow[]>();
    if (error) throw new Error(`loading --section rows failed: ${error.message}`);
    const found = new Set((data ?? []).map((s) => s.id));
    const missing = SECTION_IDS.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`--section id(s) not found in material_sections: ${missing.join(", ")}`);
    return data ?? [];
  }

  if (MATERIAL_IDS.length) {
    const { data, error } = await client
      .from("material_sections")
      .select("id, material_id, title, page_from, page_to, sort_order, status")
      .in("material_id", MATERIAL_IDS)
      .eq("status", "ready")
      .order("sort_order")
      .limit(LIMIT)
      .returns<SectionRow[]>();
    if (error) throw new Error(`loading --material sections failed: ${error.message}`);
    if (!data?.length) throw new Error(`no 'ready' material_sections found for material id(s): ${MATERIAL_IDS.join(", ")}`);
    return data;
  }

  // Auto-pick: prefer already-ready sections of a structurally-dense book
  // (the ADR-032 incident books, if any are in this DB), fall back to any
  // ready section otherwise — either way, real, already-indexed sections
  // only (never invents/fetches new text).
  const { data: materials, error: materialsErr } = await client.from("materials").select("id, name, title").returns<{ id: string; name: string; title: string | null }[]>();
  if (materialsErr) throw new Error(`loading materials failed: ${materialsErr.message}`);
  const denseMaterialIds = new Set((materials ?? []).filter((m) => DENSE_BOOK_PATTERNS.some((re) => re.test(m.name) || (m.title && re.test(m.title)))).map((m) => m.id));

  const pickFrom = async (materialIds: string[] | null): Promise<SectionRow[]> => {
    let q = client.from("material_sections").select("id, material_id, title, page_from, page_to, sort_order, status").eq("status", "ready").order("sort_order").limit(LIMIT);
    if (materialIds) q = q.in("material_id", materialIds);
    const { data, error } = await q.returns<SectionRow[]>();
    if (error) throw new Error(`auto-pick query failed: ${error.message}`);
    return data ?? [];
  };

  if (denseMaterialIds.size) {
    const dense = await pickFrom([...denseMaterialIds]);
    if (dense.length) return dense;
    console.warn("Note: a dense-book title matched, but it has no 'ready' sections yet — falling back to any ready section.");
  } else {
    console.warn("Note: none of the ADR-032 incident book titles (Історія 6 клас / Щупак, Українська мова / Семеног, Українська література / Калинич) were found in this DB — auto-picking any ready section instead.");
  }
  const any = await pickFrom(null);
  if (!any.length) throw new Error("no 'ready' material_sections found in this DB at all — pass --section/--material explicitly, or index a book first.");
  return any;
}

async function buildPromptForSection(client: ReturnType<typeof createServiceClient>, section: SectionRow): Promise<{ system: string; prompt: string; material: MaterialRow }> {
  const { data: material, error: materialErr } = await client
    .from("materials")
    .select("id, name, title, kind, grade, curriculum_version, subject_id, page_count")
    .eq("id", section.material_id)
    .maybeSingle<MaterialRow>();
  if (materialErr || !material) throw new Error(`loading material ${section.material_id} failed: ${materialErr?.message ?? "not found"}`);

  let chunkQuery = client.from("chunks").select("page, locator, text").eq("material_id", section.material_id).order("ordinal").limit(20000);
  if (section.page_from != null) chunkQuery = chunkQuery.gte("page", section.page_from);
  if (section.page_to != null) chunkQuery = chunkQuery.lte("page", section.page_to);
  const { data: chunkRows, error: chunkErr } = await chunkQuery.returns<{ page: number; locator: string | null; text: string }[]>();
  if (chunkErr) throw new Error(`loading chunks for section ${section.id} failed: ${chunkErr.message}`);
  if (!chunkRows?.length) throw new Error(`section ${section.id} (${section.title}) has no chunk text in its page range — pick a different section`);

  const pages = new Map<number, PageText>();
  for (const c of chunkRows) {
    const p = pages.get(c.page) ?? { page: c.page, locator: c.locator, text: "" };
    p.text = p.text ? `${p.text}\n${c.text}` : c.text;
    pages.set(c.page, p);
  }
  const sortedPages = [...pages.values()].sort((a, b) => a.page - b.page);

  // Same `existing_topics` context production sends: other materials' topics
  // (never this book's own — matches `runStructureSection`'s query).
  const { data: topicRows } = await client
    .from("topics")
    .select("id, title, subject_id, material_id")
    .or(`material_id.is.null,material_id.neq.${section.material_id}`)
    .order("sort_order")
    .limit(300)
    .returns<{ id: string; title: string; subject_id: string; material_id: string | null }[]>();
  const { data: subjectRows } = await client.from("subjects").select("id, name_uk").returns<{ id: string; name_uk: string }[]>();
  const subjectName = new Map((subjectRows ?? []).map((s) => [s.id, s.name_uk]));
  const topicRefs = (topicRows ?? []).map((t, i) => ({ ref: `t${i + 1}`, ...t }));

  const kindMeta = sourceTypes.get(material.kind);
  const rangeLabel = section.page_from != null ? `стор. ${section.page_from}${section.page_to != null && section.page_to !== section.page_from ? `–${section.page_to}` : ""}` : "—";

  const { system, user } = sectionPrompt();
  const prompt = fillTemplate(user, {
    file_name: material.name,
    meta_title: material.title ?? "—",
    kind_title: kindMeta?.titleUk ?? material.kind,
    section_title: section.title,
    section_range: rangeLabel,
    existing_topics: topicRefs.map((t) => `${t.ref} — ${subjectName.get(t.subject_id) ?? "?"} — ${t.title}`).join("\n") || "—",
    section_text: buildSectionText(sortedPages),
  });
  return { system, prompt, material };
}

interface CallOutcome {
  model: ModelId;
  costUsd: number;
  usage: Usage;
  latencyMs: number;
  topicsCount: number;
  problemsCount: number;
  dependenciesCount: number;
  relatedTopicsCount: number;
  answer: SectionAnswer | null;
  error: string | null;
}

async function runOne(model: ModelId, system: string, prompt: string): Promise<CallOutcome> {
  const started = Date.now();
  try {
    const { data, usage } = await anthropicStructured({ model: model.model, system, prompt, schema: buildSectionSchema(), params: PARAMS });
    const price = await loadPrice("anthropic", model.model);
    const costUsd = estimateCostUsd(price, usage);
    return {
      model,
      costUsd,
      usage,
      latencyMs: Date.now() - started,
      topicsCount: data.topics.length,
      problemsCount: data.problems.length,
      dependenciesCount: data.dependencies.length,
      relatedTopicsCount: data.related_topics.length,
      answer: data,
      error: null,
    };
  } catch (e) {
    return {
      model,
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: Date.now() - started,
      topicsCount: 0,
      problemsCount: 0,
      dependenciesCount: 0,
      relatedTopicsCount: 0,
      answer: null,
      error: (e as Error).message,
    };
  }
}

interface SectionReport {
  sectionId: string;
  materialId: string;
  materialName: string;
  sectionTitle: string;
  pageRange: string;
  opus: CallOutcome;
  sonnet: CallOutcome;
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function printMarkdown(reports: SectionReport[]) {
  console.warn("# A/B: Opus 5.5 vs Sonnet 5 для `indexing_structure` (ADR-036 recommendation #2)\n");
  console.warn(`Дата: ${new Date().toISOString()}\n`);
  console.warn("**Це порівняльний тест, НЕ зміна production-маршрутизації.** `model_routes` не змінено.\n");

  console.warn("## Вартість за виклик\n");
  console.warn("| Розділ | Модель | $ | Вхід. токени | Вих. токени | Затримка (мс) |");
  console.warn("|---|---|---|---|---|---|");
  for (const r of reports) {
    for (const o of [r.opus, r.sonnet]) {
      console.warn(
        `| ${mdEscape(r.sectionTitle)} (${r.pageRange}) | ${o.model.label} | ${o.error ? "ПОМИЛКА" : `$${o.costUsd.toFixed(4)}`} | ${o.usage.inputTokens} | ${o.usage.outputTokens} | ${o.latencyMs} |`,
      );
    }
  }
  const totalOpus = reports.reduce((s, r) => s + r.opus.costUsd, 0);
  const totalSonnet = reports.reduce((s, r) => s + r.sonnet.costUsd, 0);
  console.warn(`\n**Разом:** Opus $${totalOpus.toFixed(4)}, Sonnet $${totalSonnet.toFixed(4)} (economy ${totalOpus > 0 ? Math.round((1 - totalSonnet / totalOpus) * 100) : 0}% за цей прогін).\n`);

  console.warn("## Кількість розпізнаного (для швидкого eyeball)\n");
  console.warn("| Розділ | Модель | topics | problems (вправи, ADR-029) | dependencies | related_topics |");
  console.warn("|---|---|---|---|---|---|");
  for (const r of reports) {
    for (const o of [r.opus, r.sonnet]) {
      console.warn(`| ${mdEscape(r.sectionTitle)} | ${o.model.label} | ${o.error ? "—" : o.topicsCount} | ${o.error ? "—" : o.problemsCount} | ${o.error ? "—" : o.dependenciesCount} | ${o.error ? "—" : o.relatedTopicsCount} |`);
    }
  }

  console.warn("\n## Сирий вивід кожної моделі (для ручної перевірки номерів вправ і меж розділу)\n");
  for (const r of reports) {
    console.warn(`### ${r.sectionTitle} — ${r.materialName} (${r.pageRange})\n`);
    for (const o of [r.opus, r.sonnet]) {
      console.warn(`#### ${o.model.label}\n`);
      if (o.error) {
        console.warn(`ПОМИЛКА: ${o.error}\n`);
        continue;
      }
      console.warn("```json");
      console.warn(JSON.stringify(o.answer, null, 2));
      console.warn("```\n");
    }
  }
}

async function main() {
  const client = createServiceClient();
  console.warn(`ab:indexing-structure — ${new Date().toISOString()} — Opus 5.5 vs Sonnet 5, format: ${FORMAT}`);
  console.warn("This is a comparison test only. No writes to the database. model_routes is untouched.\n");

  const sections = await pickSections(client);
  console.warn(`Comparing ${sections.length} section(s): ${sections.map((s) => `${s.title} (${s.id})`).join("; ")}\n`);

  const reports: SectionReport[] = [];
  for (const section of sections) {
    console.warn(`Building prompt for section "${section.title}"...`);
    const { system, prompt, material } = await buildPromptForSection(client, section);
    console.warn(`  Calling Opus 5.5...`);
    const opus = await runOne(OPUS, system, prompt);
    console.warn(`  Calling Sonnet 5...`);
    const sonnet = await runOne(SONNET, system, prompt);
    reports.push({
      sectionId: section.id,
      materialId: section.material_id,
      materialName: material.title ?? material.name,
      sectionTitle: section.title,
      pageRange: section.page_from != null ? `стор. ${section.page_from}${section.page_to != null && section.page_to !== section.page_from ? `–${section.page_to}` : ""}` : "—",
      opus,
      sonnet,
    });
  }

  if (FORMAT === "md") {
    printMarkdown(reports);
  } else {
    console.warn(JSON.stringify({ generatedAt: new Date().toISOString(), note: "Comparison test only — model_routes unchanged.", reports }, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
