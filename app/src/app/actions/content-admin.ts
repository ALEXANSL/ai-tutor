"use server";

import { revalidatePath } from "next/cache";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import {
  getSubjectCleanupPreview,
  listSubjectLessons,
  listSubjectPackages,
  listSubjectPdfMaterials,
  type LessonSystem,
  type PackageKind,
} from "@/server/subjects/contentAdmin";

/**
 * S42 (E-29, US-29.1/29.2/29.3): server actions behind the parent cabinet's
 * content-admin screen — every write goes through a SECURITY DEFINER RPC
 * (`20261022100000_s42_admin_content_ops.sql`), never a direct table write,
 * same two-layer "parent only" gate as `app/actions/subjects.ts` (E-22).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYSTEMS: readonly LessonSystem[] = ["literature", "course", "course_v2", "literature_v2"];
const t = uk.parent.contentAdmin;

function isSystem(v: string): v is LessonSystem {
  return (SYSTEMS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// US-29.1: "Очистити старий контент" — preview, then archive (never delete).
// ---------------------------------------------------------------------------

export type CleanupPreviewState =
  | ({ status: "ok" } & Awaited<ReturnType<typeof getSubjectCleanupPreview>>)
  | { status: "error"; message: string };

export async function previewSubjectCleanupAction(subjectId: string): Promise<CleanupPreviewState> {
  const { familyId } = await requireParentAccess();
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  const preview = await getSubjectCleanupPreview(familyId, subjectId);
  return { status: "ok", ...preview };
}

export type CleanupConfirmState = { status: "ok"; lessonsArchived: number; topicsArchived: number } | { status: "error"; message: string };

/** КП-3/КП-4: called only after the UI's own second explicit confirmation step. */
export async function confirmSubjectCleanupAction(subjectId: string): Promise<CleanupConfirmState> {
  const { familyId } = await requireParentAccess();
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  const scope = forFamily(familyId);
  const { data, error } = await scope.client.rpc("admin_archive_subject_content", { p_family_id: familyId, p_subject_id: subjectId }).maybeSingle<{
    out_lessons_archived: number;
    out_topics_archived: number;
  }>();
  if (error || !data) return { status: "error", message: error?.code === "P0002" ? t.errors.subjectNotFound : uk.common.error };
  revalidatePath(`/parent/subjects/${subjectId}`, "page");
  revalidatePath(`/parent/subjects/${subjectId}/content`, "page");
  revalidatePath("/parent/subjects", "layout");
  return { status: "ok", lessonsArchived: data.out_lessons_archived, topicsArchived: data.out_topics_archived };
}

// ---------------------------------------------------------------------------
// US-29.3: per-lesson toggle (reversible) and delete (only without progress).
// ---------------------------------------------------------------------------

export type ListLessonsState = { status: "ok"; lessons: Awaited<ReturnType<typeof listSubjectLessons>> } | { status: "error"; message: string };

export async function listSubjectLessonsAction(subjectId: string): Promise<ListLessonsState> {
  const { familyId } = await requireParentAccess();
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  return { status: "ok", lessons: await listSubjectLessons(familyId, subjectId) };
}

export type ToggleLessonState = { status: "ok" } | { status: "error"; message: string };

export async function toggleLessonStatusAction(system: string, lessonId: string, enabled: boolean): Promise<ToggleLessonState> {
  const { familyId } = await requireParentAccess();
  if (!isSystem(system) || !UUID.test(lessonId)) return { status: "error", message: uk.common.error };
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("admin_set_lesson_status", {
    p_family_id: familyId,
    p_system: system,
    p_lesson_id: lessonId,
    p_status: enabled ? "active" : "disabled",
  });
  if (error) return { status: "error", message: error.code === "P0003" ? t.errors.lessonNotFound : uk.common.error };
  revalidatePath("/parent/subjects", "layout");
  return { status: "ok" };
}

export type DeleteLessonState = { status: "ok" } | { status: "blocked"; message: string } | { status: "error"; message: string };

export async function deleteLessonAction(system: string, lessonId: string): Promise<DeleteLessonState> {
  const { familyId } = await requireParentAccess();
  if (!isSystem(system) || !UUID.test(lessonId)) return { status: "error", message: uk.common.error };
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("admin_delete_lesson", { p_family_id: familyId, p_system: system, p_lesson_id: lessonId });
  if (error) {
    if (error.code === "P0016") return { status: "blocked", message: t.errors.hasProgress };
    return { status: "error", message: error.code === "P0003" ? t.errors.lessonNotFound : uk.common.error };
  }
  revalidatePath("/parent/subjects", "layout");
  return { status: "ok" };
}

// ---------------------------------------------------------------------------
// US-29.2: textbook linking form.
// ---------------------------------------------------------------------------

export type SubjectPackagesState =
  | { status: "ok"; packages: Awaited<ReturnType<typeof listSubjectPackages>>; pdfOptions: Awaited<ReturnType<typeof listSubjectPdfMaterials>> }
  | { status: "error"; message: string };

export async function listSubjectPackagesAction(subjectId: string): Promise<SubjectPackagesState> {
  const { familyId } = await requireParentAccess();
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  const [packages, pdfOptions] = await Promise.all([listSubjectPackages(familyId, subjectId), listSubjectPdfMaterials(familyId, subjectId)]);
  return { status: "ok", packages, pdfOptions };
}

export type LinkTextbookState = { status: "ok"; pageWarning: boolean } | { status: "error"; message: string };

/** КП-1/КП-2 (apply to the whole package at once) + КП-3 (page-coverage warning, never blocking). */
export async function linkPackageTextbookAction(kind: string, packageId: string, materialId: string | null): Promise<LinkTextbookState> {
  const { familyId } = await requireParentAccess();
  if ((kind !== "course_v2" && kind !== "literature_v2") || !UUID.test(packageId) || (materialId !== null && !UUID.test(materialId))) {
    return { status: "error", message: uk.common.error };
  }
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("admin_set_package_textbook", { p_family_id: familyId, p_kind: kind, p_package_id: packageId, p_material_id: materialId });
  if (error) return { status: "error", message: error.code === "P0017" ? t.errors.materialNotFound : uk.common.error };

  let pageWarning = false;
  if (materialId) {
    const kindKey = kind as PackageKind;
    const [packages, pdfOptions] = await Promise.all([listSubjectPackagesForMaterialCheck(familyId, packageId, kindKey), listSubjectPdfMaterialsById(familyId, materialId)]);
    if (packages && pdfOptions && packages.maxPrintedPageTo != null && pdfOptions.pageCount != null && pdfOptions.pageCount < packages.maxPrintedPageTo) {
      pageWarning = true;
    }
  }

  revalidatePath("/parent/subjects", "layout");
  return { status: "ok", pageWarning };
}

/**
 * Exported (not just used by `linkPackageTextbookAction` above) so S43's
 * import-time textbook linking (`literature-course-v2.ts`/`math-course-v2.ts`)
 * can reuse the exact same КП-3 page-coverage check instead of duplicating it.
 */
export async function listSubjectPackagesForMaterialCheck(familyId: string, packageId: string, kind: PackageKind) {
  const scope = forFamily(familyId);
  const table = kind === "course_v2" ? "course_v2_lessons" : "literature_v2_lessons";
  const { data } = await scope.select(table, "printed_page_to").eq("package_id", packageId).returns<{ printed_page_to: number | null }[]>();
  const maxPrintedPageTo = (data ?? []).reduce<number | null>((m, l) => (l.printed_page_to != null && (m == null || l.printed_page_to > m) ? l.printed_page_to : m), null);
  return { maxPrintedPageTo };
}

export async function listSubjectPdfMaterialsById(familyId: string, materialId: string) {
  const scope = forFamily(familyId);
  const { data } = await scope.select("materials", "page_count").eq("id", materialId).maybeSingle<{ page_count: number | null }>();
  return data ? { pageCount: data.page_count } : null;
}

// ---------------------------------------------------------------------------
// S43 (PO request 2026-10-13, exact wording: "там же є сенс додати
// завантаження або прив'язку підручника до предмету") — the import screen's
// own "Підручник (необов'язково)" dropdown, so linking no longer needs a
// separate visit to `/parent/subjects/[id]` after the import. Thin wrapper
// over the same read model `TextbookLinkPanel` already uses.
// ---------------------------------------------------------------------------

export type ListSubjectPdfMaterialsState = { status: "ok"; pdfOptions: Awaited<ReturnType<typeof listSubjectPdfMaterials>> } | { status: "error"; message: string };

export async function listSubjectPdfMaterialsAction(subjectId: string): Promise<ListSubjectPdfMaterialsState> {
  const { familyId } = await requireParentAccess();
  if (!UUID.test(subjectId)) return { status: "error", message: uk.common.error };
  return { status: "ok", pdfOptions: await listSubjectPdfMaterials(familyId, subjectId) };
}

export interface TextbookLinkWarning {
  file: string;
  field: string;
  message: string;
}

/**
 * S43: the SAME `admin_set_package_textbook` RPC `linkPackageTextbookAction`
 * above calls, reused (not duplicated) by `importLiteratureV2Action`/
 * `importMathCourseV2Action` so the import screen's own textbook dropdown can
 * link right after a successful import. Never throws and never fails the
 * import — a failed link, or the same КП-3 page-coverage mismatch
 * `linkPackageTextbookAction` warns about, becomes one warning entry in the
 * import summary instead (caller's `warnings` array).
 */
export async function linkTextbookBestEffort(familyId: string, kind: PackageKind, packageId: string, materialId: string): Promise<TextbookLinkWarning | null> {
  const scope = forFamily(familyId);
  const { error } = await scope.client.rpc("admin_set_package_textbook", { p_family_id: familyId, p_kind: kind, p_package_id: packageId, p_material_id: materialId });
  if (error) {
    return { file: "textbook", field: "link", message: error.code === "P0017" ? t.errors.materialNotFound : `Не вдалося прив'язати підручник: ${error.message}` };
  }

  const [packages, pdfOption] = await Promise.all([listSubjectPackagesForMaterialCheck(familyId, packageId, kind), listSubjectPdfMaterialsById(familyId, materialId)]);
  if (packages && pdfOption && packages.maxPrintedPageTo != null && pdfOption.pageCount != null && pdfOption.pageCount < packages.maxPrintedPageTo) {
    return { file: "textbook", field: "link", message: t.textbook.pageWarning };
  }
  return null;
}
