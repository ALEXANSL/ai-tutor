"use server";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily, type FamilyScope } from "@/server/db/family-scope";
import { createServiceClient } from "@/server/supabase/clients";
import { MAX_COURSE_ZIP_BYTES } from "@/lib/upload-limits";
import { parseUnifiedCourseArchive, type UnifiedCourseArchive } from "@/server/lessons/unifiedCourseArchive";
import { persistLiteratureV3Package } from "@/server/lessons/literatureV3Persist";
import { persistLiteratureV2Package } from "@/server/lessons/literatureV2Persist";
import { persistMathCourseV2Package } from "@/server/lessons/mathCourseV2Persist";
import { persistCoursePackage } from "@/server/lessons/coursePersist";
import { persistLiteratureTopic } from "@/server/lessons/literatureExtraction";
import { acquireUnifiedImport, completeUnifiedImport, failUnifiedImport, findCompletedUnifiedImport, isUnifiedImportStoragePath, type UnifiedImportSavedSummary } from "@/server/lessons/unifiedImportLifecycle";
interface Input { subjectId: string; storagePath: string }
interface Preview { title: string; formatLabel: string; lessons: number; tasks: number; images: number; pdfs: number; warnings: string[]; existing: boolean; fingerprint: string; canImport: boolean }
type Failure = { status: "error"; message: string; retryable?: boolean };
const bucket = "course_import_staging";
const labels = { chapter_v3: "Універсальний пакет курсу", math_v2: "Пакет математики", literature_v2: "Пакет літератури", course_v1: "Пакет уроків", markdown_v1: "Текстові уроки" };
const tables = { chapter_v3: "literature_v3_packages", math_v2: "course_v2_packages", literature_v2: "literature_v2_packages", course_v1: "course_packages" };
const notes = (values: string[]) => [...new Set(values)].slice(0, 2000).map(value => value.slice(0, 4000));
const message = (error: unknown) => error instanceof Error ? error.message.slice(0, 2000) : "Не вдалося обробити архів.";
async function context(input: Input) {
  const { familyId } = await requireParentAccess();
  if (!z.string().uuid().safeParse(input.subjectId).success || !isUnifiedImportStoragePath(familyId, input.storagePath)) throw new Error("Невірний предмет або шлях архіву.");
  const scope = forFamily(familyId, createServiceClient());
  const result = await scope.select("subjects", "id").eq("id", input.subjectId).maybeSingle<{ id: string }>();
  if (result.error) throw new Error("Не вдалося перевірити предмет.");
  if (!result.data) throw new Error("Предмет не знайдено.");
  return scope;
}
async function read(scope: FamilyScope, input: Input) {
  const result = await scope.client.storage.from(bucket).download(input.storagePath);
  if (result.error || !result.data) throw new Error("Тимчасовий архів недоступний. Завантажте ZIP знову.");
  if (!result.data.size || result.data.size > MAX_COURSE_ZIP_BYTES) throw new Error("Архів порожній або завеликий.");
  const bytes = new Uint8Array(await result.data.arrayBuffer());
  const archive = parseUnifiedCourseArchive(bytes);
  if (archive.errors.length) throw new Error(archive.errors.slice(0, 8).map(issue => `${issue.file ?? "Пакет"}: ${issue.field}: ${issue.message}`).join("\n"));
  return { archive, fingerprint: createHash("sha256").update(bytes).digest("hex") };
}
async function target(scope: FamilyScope, subjectId: string, archive: UnifiedCourseArchive) {
  if (archive.format === "markdown_v1") {
    const result = await scope.select("materials", "id,grade").eq("subject_id", subjectId).limit(2).returns<{ id: string; grade: number | null }[]>();
    if (result.error) throw new Error("Не вдалося перевірити підручник.");
    const rows = result.data;
    if (rows?.length !== 1) throw new Error("Для старого текстового пакета потрібен один підручник предмета. Якщо книг кілька, скористайтеся старим способом завантаження нижче.");
    return { existing: true, material: rows[0]! };
  }
  const result = await scope.select(tables[archive.format], "id,subject_id").eq("package_key", archive.packageId).maybeSingle<{ id: string; subject_id: string }>();
  if (result.error) throw new Error("Не вдалося перевірити попередню версію курсу.");
  if (result.data && result.data.subject_id !== subjectId) throw new Error("Цей пакет уже належить іншому предмету. Оберіть початковий предмет або інший ідентифікатор пакета.");
  return { existing: !!result.data, material: null };
}
export async function inspectUnifiedCourseAction(input: Input): Promise<{ status: "ready"; preview: Preview } | Failure> {
  try {
    const scope = await context(input);
    const { archive, fingerprint } = await read(scope, input);
    const destination = await target(scope, input.subjectId, archive);
    return { status: "ready", preview: { title: archive.title, formatLabel: labels[archive.format], ...archive.counts, fingerprint, existing: destination.existing, canImport: true, warnings: notes([...archive.warnings.map(issue => `${issue.file ?? "Пакет"}: ${issue.message}`), ...(destination.existing ? ["Курс буде оновлено за стабільними ідентифікаторами. Якщо імпорт перерветься, частина матеріалів може оновитися; повторіть імпорт того самого архіву."] : [])]) } };
  } catch (error) { unstable_rethrow(error); return { status: "error", message: message(error) }; }
}
export async function importUnifiedCourseAction(input: Input & { fingerprint: string }): Promise<{ status: "ok"; summary: UnifiedImportSavedSummary } | Failure> {
  let active: { scope: FamilyScope; jobId: string } | undefined;
  try {
    const scope = await context(input);
    if (!/^[a-f0-9]{64}$/.test(input.fingerprint)) return { status: "error", message: "Спочатку перевірте архів.", retryable: false };
    const previous = await findCompletedUnifiedImport(scope, input);
    if (previous) return { status: "ok", summary: previous };
    const { archive, fingerprint } = await read(scope, input);
    if (fingerprint !== input.fingerprint) return { status: "error", message: "Архів змінився. Перевірте його знову.", retryable: false };
    const destination = await target(scope, input.subjectId, archive);
    const lock = await acquireUnifiedImport(scope, { ...input, format: archive.format, packageKey: destination.material?.id ?? archive.packageId });
    if ("busy" in lock) return { status: "error", message: "Цей курс уже імпортується. Зачекайте і повторіть спробу.", retryable: true };
    active = { scope, jobId: lock.jobId };
    await target(scope, input.subjectId, archive);
    let assetsUploaded = 0;
    const warnings = archive.warnings.map(issue => `${issue.file ?? "Пакет"}: ${issue.message}`);
    const ctx = { subjectId: input.subjectId, grade: null };
    if (archive.format === "markdown_v1") {
      const material = destination.material!;
      let order = 0;
      for (const topic of [...archive.parsed.topics].sort((a, b) => a.topicNo - b.topicNo)) await persistLiteratureTopic(scope, { ...ctx, materialId: material.id, grade: material.grade }, topic, ++order, "manual_import", null);
    } else {
      const saved = archive.format === "chapter_v3" ? await persistLiteratureV3Package(scope, ctx, archive.parsed, archive.assetFiles)
        : archive.format === "math_v2" ? await persistMathCourseV2Package(scope, ctx, archive.parsed, archive.assetFiles)
        : archive.format === "literature_v2" ? await persistLiteratureV2Package(scope, ctx, archive.parsed, archive.assetFiles)
        : await persistCoursePackage(scope, ctx, archive.parsed);
      assetsUploaded = saved.assetsUploaded;
      for (const failure of saved.assetUploadFailures) warnings.push(`${failure.path}: ${failure.message}`);
      if ("assetReuseWarnings" in saved) for (const warning of saved.assetReuseWarnings ?? []) warnings.push(`${warning.path}: ${warning.message}`);
    }
    const summary = { title: archive.title, lessons: archive.counts.lessons, tasks: archive.counts.tasks, assetsUploaded, warnings: notes(warnings) };
    await completeUnifiedImport(scope, lock.jobId, summary);
    active = undefined;
    await scope.client.storage.from(bucket).remove([input.storagePath]).catch(() => undefined);
    revalidatePath("/parent/materials");
    return { status: "ok", summary };
  } catch (error) {
    unstable_rethrow(error);
    if (active) {
      await failUnifiedImport(active.scope, active.jobId).catch(() => undefined);
      return { status: "error", message: `Імпорт перервано. Частина матеріалів могла оновитися. Повторіть імпорт цього архіву. ${message(error)}`, retryable: true };
    }
    return { status: "error", message: message(error), retryable: false };
  }
}
