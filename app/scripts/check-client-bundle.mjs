// Verifies that no server secret reaches the browser bundle (NFR-PRIV-3).
//
// How: build the app with every secret env var set to a unique canary value,
// then scan everything that is served to the browser (.next/static, public/)
// for those canaries, for secret variable NAMES and for server-only modules.
//
//   node scripts/check-client-bundle.mjs --build   # sets canaries, builds, scans
//   node scripts/check-client-bundle.mjs           # scans the existing build
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "ALLOWLIST_PARENT_EMAILS",
  "ALLOWLIST_CHILD_EMAILS",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_API_KEY",
  "GOOGLE_DRIVE_FOLDER_ID",
  "GOOGLE_DRIVE_ARCHIVE_FOLDER_ID",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "ALERT_EMAIL_TO",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "ALERTS_IN_UA_TOKEN",
  "CRON_SECRET",
  "PIN_PEPPER",
];
const SERVER_ONLY_MARKERS = [
  "@node-rs/argon2",
  "createServiceClient",
  "register_app_user",
  "deriveParentModeKey",
  // S1: AI router, search, Drive access
  "record_ai_call",
  "search_chunks",
  "buildServiceAccountAssertion",
  "api.openai.com",
  "drive.readonly",
];

const env = { ...process.env };
if (process.argv.includes("--build")) {
  for (const name of SECRET_VARS) {
    const canary = `CANARY_${name}_${randomBytes(6).toString("hex")}`;
    env[name] = name.startsWith("ALLOWLIST") || name === "ALERT_EMAIL_TO" ? `${canary.toLowerCase()}@example.com` : canary;
  }
  env.NEXT_PUBLIC_SUPABASE_URL ||= "https://canary-project.supabase.co";
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "public-anon-key-canary";
  execSync("npx next build --webpack", { cwd: APP, env, stdio: "inherit" });
}

const roots = [join(APP, ".next", "static"), join(APP, "public")];
if (!existsSync(roots[0])) {
  console.error("No build found. Run with --build.");
  process.exit(2);
}

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|css|html|json|txt|map|webmanifest)$/.test(name)) files.push(p);
  }
};
roots.filter(existsSync).forEach(walk);

const needles = [];
for (const name of SECRET_VARS) {
  needles.push({ what: `variable name ${name}`, value: name });
  const value = env[name];
  if (value && value.length >= 8) {
    for (const part of value.split(/[,;\s]+/).filter((v) => v.length >= 8)) {
      needles.push({ what: `value of ${name}`, value: part });
    }
  }
}
for (const marker of SERVER_ONLY_MARKERS) needles.push({ what: `server-only code "${marker}"`, value: marker });

const problems = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const n of needles) if (text.includes(n.value)) problems.push(`${n.what} found in ${file.slice(APP.length + 1)}`);
}

if (problems.length) {
  console.error(`Client bundle check FAILED:\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.warn(`Client bundle check passed: ${files.length} browser-served files, ${needles.length} needles, 0 leaks.`);
