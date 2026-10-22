import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { forFamily, type FamilyScope } from "@/server/db/family-scope";
import { enqueueJob, registerJobHandler } from "@/server/jobs/runner";

export const UNIFIED_IMPORT_JOB = "course_zip.import";
export const UNIFIED_IMPORT_CLEANUP_JOB = "course_zip.cleanup";
const STAGING_BUCKET = "course_import_staging";
const RETENTION_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;

const summarySchema = z.object({
  title: z.string().max(1000),
  lessons: z.number().int().nonnegative(),
  tasks: z.number().int().nonnegative(),
  assetsUploaded: z.number().int().nonnegative(),
  warnings: z.array(z.string().max(4000)).max(2000),
}).strict();
export type UnifiedImportSavedSummary = z.infer<typeof summarySchema>;
export interface UnifiedImportIdentity { subjectId: string; storagePath: string; fingerprint: string }
interface ImportPayload extends UnifiedImportIdentity { summary?: UnifiedImportSavedSummary }

/** The signed-upload route issues exactly one opaque filename below this
 * family's prefix. Reject paths that could be interpreted as another object. */
export function isUnifiedImportStoragePath(familyId: string, path: string): boolean {
  if (!familyId || typeof path !== "string" || path.length > 512 || /[\\\u0000-\u001f]/u.test(path)) return false;
  const parts = path.split("/");
  return parts.length === 2 && parts[0] === familyId && !!parts[1] && /\.zip$/iu.test(parts[1]);
}

function assertIdentity(familyId: string, input: UnifiedImportIdentity): void {
  if (!isUnifiedImportStoragePath(familyId, input.storagePath) || !input.subjectId || !/^[a-f0-9]{64}$/u.test(input.fingerprint)) {
    throw new Error("Невірні дані завантаженого архіву.");
  }
}

export async function scheduleUnifiedImportCleanup(familyId: string, storagePath: string): Promise<void> {
  if (!isUnifiedImportStoragePath(familyId, storagePath)) throw new Error("Невірний шлях завантаженого архіву.");
  await enqueueJob(familyId, UNIFIED_IMPORT_CLEANUP_JOB, { storagePath }, {
    dedupeKey: `course_zip.cleanup:${storagePath}`,
    runAfter: new Date(Date.now() + RETENTION_MS),
    maxAttempts: 5,
  });
}

export async function findCompletedUnifiedImport(scope: FamilyScope, input: UnifiedImportIdentity): Promise<UnifiedImportSavedSummary | null> {
  assertIdentity(scope.familyId, input);
  const { data, error } = await scope.select("jobs", "payload")
    .eq("type", UNIFIED_IMPORT_JOB).eq("status", "done")
    .eq("payload->>storagePath", input.storagePath).eq("payload->>fingerprint", input.fingerprint)
    .eq("payload->>subjectId", input.subjectId).order("created_at", { ascending: false }).limit(1)
    .maybeSingle<{ payload: unknown }>();
  if (error) throw new Error("Не вдалося перевірити результат попереднього імпорту.");
  if (!data || !data.payload || typeof data.payload !== "object") return null;
  const payload = data.payload as ImportPayload;
  if (payload.storagePath !== input.storagePath || payload.fingerprint !== input.fingerprint || payload.subjectId !== input.subjectId) return null;
  const result = summarySchema.safeParse(payload.summary);
  return result.success ? result.data : null;
}

export async function acquireUnifiedImport(
  scope: FamilyScope,
  input: UnifiedImportIdentity & { format: string; packageKey: string },
): Promise<{ jobId: string } | { busy: true }> {
  assertIdentity(scope.familyId, input);
  if (!input.format || !input.packageKey) throw new Error("Невірний ідентифікатор пакета.");
  const digest = createHash("sha256").update(JSON.stringify([input.format, input.packageKey])).digest("hex");
  const dedupeKey = `course_zip.import:${digest}`;
  const now = new Date();
  // Requests are capped at 300 s. Ten-minute leases cannot expire while a
  // supported request is still legitimately persisting this package.
  const stale = await scope.update("jobs", { status: "failed", locked_until: null, last_error: "Попередній імпорт було перервано. Архів можна завантажити повторно." })
    .eq("type", UNIFIED_IMPORT_JOB).eq("dedupe_key", dedupeKey).eq("status", "running").lt("locked_until", now.toISOString());
  if (stale.error) throw new Error("Не вдалося перевірити активний імпорт.");
  const { data, error } = await scope.insert("jobs", {
    type: UNIFIED_IMPORT_JOB,
    status: "running",
    attempts: 1,
    max_attempts: 1,
    dedupe_key: dedupeKey,
    locked_until: new Date(now.getTime() + LOCK_MS).toISOString(),
    payload: { subjectId: input.subjectId, storagePath: input.storagePath, fingerprint: input.fingerprint },
  }).select("id").single<{ id: string }>();
  if (error?.code === "23505") return { busy: true };
  if (error || !data) throw new Error("Не вдалося почати імпорт архіву.");
  return { jobId: data.id };
}

export async function completeUnifiedImport(scope: FamilyScope, jobId: string, summary: UnifiedImportSavedSummary): Promise<void> {
  const safeSummary = summarySchema.parse(summary);
  const { data, error } = await scope.select("jobs", "payload")
    .eq("id", jobId).eq("type", UNIFIED_IMPORT_JOB).eq("status", "running")
    .maybeSingle<{ payload: Record<string, unknown> }>();
  if (error || !data) throw new Error("Не вдалося зберегти результат імпорту.");
  const saved = await scope.update("jobs", { status: "done", locked_until: null, last_error: null, payload: { ...data.payload, summary: safeSummary } })
    .eq("id", jobId).eq("type", UNIFIED_IMPORT_JOB).eq("status", "running")
    .gt("locked_until", new Date().toISOString()).select("id").maybeSingle<{ id: string }>();
  if (saved.error || !saved.data) throw new Error("Не вдалося підтвердити завершення імпорту.");
}

export async function failUnifiedImport(scope: FamilyScope, jobId: string): Promise<void> {
  const { error } = await scope.update("jobs", { status: "failed", locked_until: null, last_error: "Імпорт не завершено. Архів збережено для повторної спроби." })
    .eq("id", jobId).eq("type", UNIFIED_IMPORT_JOB).eq("status", "running");
  if (error) throw new Error("Не вдалося оновити стан імпорту.");
}

export function registerUnifiedImportJobs(): void {
  registerJobHandler(UNIFIED_IMPORT_CLEANUP_JOB, {
    async run(job) {
      const storagePath = job.payload.storagePath;
      if (typeof storagePath !== "string" || !isUnifiedImportStoragePath(job.family_id, storagePath)) throw new Error("Невірний шлях тимчасового архіву.");
      const scope = forFamily(job.family_id);
      const active = await scope.select("jobs", "id").eq("type", UNIFIED_IMPORT_JOB).eq("status", "running")
        .eq("payload->>storagePath", storagePath).gt("locked_until", new Date().toISOString()).limit(1)
        .maybeSingle<{ id: string }>();
      if (active.error) throw new Error("Не вдалося перевірити стан тимчасового архіву.");
      if (active.data) return { requeue: true, delaySeconds: 600 };
      const removed = await scope.client.storage.from(STAGING_BUCKET).remove([storagePath]);
      if (removed.error) throw new Error("Не вдалося прибрати тимчасовий архів.");
    },
    isRetryable: error => !(error instanceof Error && error.message === "Невірний шлях тимчасового архіву."),
  });
  // This is a foreground import, not work the background runner may repeat.
  // claim_jobs reaches it only after its ten-minute lease expired.
  registerJobHandler(UNIFIED_IMPORT_JOB, {
    async run() { throw new Error("Попередній імпорт було перервано. Повторіть завантаження архіву."); },
    isRetryable: () => false,
  });
}
