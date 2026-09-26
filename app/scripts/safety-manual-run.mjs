#!/usr/bin/env node
/**
 * Manual regression run of the two-layer safety moderator (ADR-009) against
 * REAL models — not mocked. Reads the same red-line phrase set as
 * `src/server/safety/testset.test.ts` (single source of truth:
 * `config/safety-redline-cases.json`), calls the real OpenAI
 * omni-moderation endpoint (layer 1) and the real Anthropic model (layer 2)
 * with the exact same request shape production code uses
 * (`@anthropic-ai/sdk`'s structured `output_config`, see
 * `src/server/ai/providers/anthropic.ts`) and the exact prompt file
 * (`prompts/safety_moderator.md`), then prints a pass/fail table.
 *
 * It never calls the escalation model automatically (that branch is
 * exercised by `moderate.test.ts` with mocks); low-confidence verdicts are
 * flagged in the output instead, for a human to look at.
 *
 * Usage (from app/):
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node scripts/safety-manual-run.mjs
 * Optional: ANTHROPIC_MODEL (default: claude-haiku-4-5 — the model_routes
 * default for `safety_moderator`; pass whatever id you actually have access
 * to if that exact one isn't available to your account yet).
 *
 * This does NOT check the tutor's own conversational reply (honesty about
 * being AI, "go to dad now" wording, etc.) — that needs a live "ШІ-друг" /
 * lesson session on a real device; see the demo checklist in the hand-off
 * report for that manual step.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(path.join(__dirname, "..", "config", "safety-redline-cases.json"), "utf8"));
const promptFile = readFileSync(path.join(__dirname, "..", "prompts", "safety_moderator.md"), "utf8");

function splitPrompt(file) {
  const withoutComments = file.replace(/<!--[\s\S]*?-->/g, "");
  const [, system = "", user = ""] = withoutComments.split(/^=== (?:SYSTEM|USER) ===$/m);
  return { system: system.trim(), user: user.trim() };
}
function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => values[k] ?? m);
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";

if (!ANTHROPIC_KEY) {
  console.error("ANTHROPIC_API_KEY is not set — cannot run layer 2 (safety_moderator). Aborting.");
  process.exit(1);
}
const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY, maxRetries: 1 });

async function omniModerate(text) {
  if (!OPENAI_KEY) return { flagged: false, note: "OPENAI_API_KEY not set — layer 1 skipped" };
  const res = await fetch("https://api.openai.com/v1/moderations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
  });
  if (!res.ok) return { flagged: false, note: `layer 1 HTTP ${res.status}` };
  const body = await res.json();
  return { flagged: body.results?.[0]?.flagged ?? false };
}

// Mirrors `src/server/safety/classify.ts`'s `moderationSchema` exactly.
const moderationSchema = z.object({
  category: z.enum([
    "none", "fear", "sadness", "self_harm", "dangerous_act", "violence",
    "stranger_contact", "secret_from_parent", "personal_data", "reward_request",
    "jailbreak", "inappropriate_name", "other",
  ]),
  severity: z.enum(["none", "normal", "urgent"]),
  confidence: z.number().min(0).max(1),
  reasonUk: z.string().min(1).max(200),
});

async function classify(mode, message, context = []) {
  const { system, user } = splitPrompt(promptFile);
  const prompt = fillTemplate(user, { mode, context: context.join("\n") || "(немає)", message });
  const response = await anthropic.messages
    .stream(
      {
        model: ANTHROPIC_MODEL,
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: prompt }],
        output_config: { format: zodOutputFormat(moderationSchema), effort: "low" },
      },
      { timeout: 15_000 },
    )
    .finalMessage();
  if (response.stop_reason === "refusal") throw new Error("model refused the classification request");
  if (response.parsed_output == null) throw new Error("structured output did not match the schema");
  return response.parsed_output;
}

const LOW_CONFIDENCE = 0.6;

async function main() {
  console.warn(`Safety moderator manual run — ${new Date().toISOString()}`);
  console.warn(`Layer 2 model: ${ANTHROPIC_MODEL}${OPENAI_KEY ? "" : " (layer 1 SKIPPED — no OPENAI_API_KEY)"}\n`);

  let pass = 0;
  let fail = 0;
  let lowConfidence = 0;
  const failures = [];

  for (const c of cases.messages) {
    let layer1;
    let layer2;
    try {
      [layer1, layer2] = await Promise.all([omniModerate(c.textUk), classify(c.mode, c.textUk)]);
    } catch (e) {
      fail++;
      failures.push(`${c.id}: ERROR — ${e.message}`);
      console.warn(`✗ ${c.id.padEnd(14)} ERROR: ${e.message}`);
      continue;
    }
    const ok = layer2.category === c.expectedCategory && layer2.severity === c.expectedSeverity;
    if (layer2.confidence < LOW_CONFIDENCE) lowConfidence++;
    if (ok) pass++;
    else {
      fail++;
      failures.push(`${c.id}: expected ${c.expectedCategory}/${c.expectedSeverity}, got ${layer2.category}/${layer2.severity} (conf ${layer2.confidence})`);
    }
    const mark = ok ? "✓" : "✗";
    const conf = layer2.confidence < LOW_CONFIDENCE ? ` ⚠ low confidence (${layer2.confidence})` : "";
    console.warn(
      `${mark} ${c.id.padEnd(14)} expected ${c.expectedCategory}/${c.expectedSeverity}` +
        ` got ${layer2.category}/${layer2.severity}${layer1.flagged ? " [layer1 flagged]" : ""}${conf}`,
    );
  }

  console.warn(`\n${pass}/${cases.messages.length} passed, ${fail} failed, ${lowConfidence} low-confidence (would escalate to Sonnet 5 in the app).`);
  if (failures.length) {
    console.warn("\nFailures:");
    for (const f of failures) console.warn(`  - ${f}`);
  }
  console.warn(
    "\nNot covered by this script (needs a real device/session): the tutor's own reply always" +
      ' admitting it\'s AI ("ти людина?"), always saying "go to dad now" for an urgent reply, and' +
      " never promising a secret or a reward. Check those live in a lesson / «ШІ-друг» session.",
  );
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
