"use server";

import { revalidatePath } from "next/cache";
import { sourceTypes } from "@/core/registries/learning";
import { uk } from "@/i18n/uk";
import { registerAll } from "@/modules";
import { requireParentAccess } from "@/server/auth/guards";
import { listBooks, type BookListItem } from "@/server/books/queries";
import { forFamily } from "@/server/db/family-scope";
import { DriveError } from "@/server/drive/google";
import { getFolderAccessStatus } from "@/server/drive/service";
import { confirmBookOcr, requestReindex, syncDriveFolder } from "@/server/ingest/pipeline";
import { kickJobs } from "@/server/jobs/kick";
import { searchMaterials, type SearchHit } from "@/server/search/search";
import type { FormState } from "./state";

/**
 * "Мої книги" actions (US-2.1…2.7). Every action re-checks the parent role on
 * the server (parent account or PIN-unlocked parent mode).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const t = uk.parent.books;

function uuidOf(formData: FormData, key: string): string | null {
  const v = String(formData.get(key) ?? "");
  return UUID.test(v) ? v : null;
}

/** "Я додав — перевірити папку" (US-2.7 KP-4): new files appear as "індексується" right away. */
export async function checkFolderAction(): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  try {
    const s = await syncDriveFolder(familyId);
    kickJobs();
    revalidatePath("/parent/books", "layout");
    return { status: "ok", message: t.add.result(s.added, s.updated, s.removed) + (s.deferred ? t.add.deferred(s.deferred) : "") };
  } catch (e) {
    if (e instanceof DriveError && e.code === "not_configured") return { status: "error", message: t.add.notConfigured };
    console.error(`checkFolder failed: ${(e as Error).name}`);
    return { status: "error", message: t.add.failed };
  }
}

export async function reindexAction(formData: FormData): Promise<void> {
  const { familyId } = await requireParentAccess();
  const id = uuidOf(formData, "materialId");
  if (!id) return;
  await requestReindex(familyId, id);
  kickJobs();
  revalidatePath("/parent/books", "layout");
}

/** "Розпізнати" (D-54): the parent confirms OCR of a large scan before any AI spend. */
export async function confirmOcrAction(formData: FormData): Promise<void> {
  const { familyId, ctx } = await requireParentAccess();
  const id = uuidOf(formData, "materialId");
  if (!id) return;
  await confirmBookOcr(familyId, id, ctx.appUserId);
  kickJobs();
  revalidatePath("/parent/books", "layout");
}

export async function setUseInLessonsAction(materialId: string, use: boolean): Promise<void> {
  const { familyId } = await requireParentAccess();
  if (!UUID.test(materialId)) return;
  const { error } = await forFamily(familyId).update("materials", { use_in_lessons: use }).eq("id", materialId);
  if (error) throw new Error(error.message);
  revalidatePath("/parent/books", "layout");
}

/** Polled by "Мої книги" while something is indexing: keeps the pipeline moving without cron. */
export async function pollIndexingAction(): Promise<BookListItem[]> {
  const { familyId } = await requireParentAccess();
  const books = await listBooks(familyId);
  if (books.some((b) => b.status === "queued" || b.status === "indexing")) kickJobs();
  return books;
}

export async function recheckFolderAccessAction(): Promise<void> {
  const { familyId } = await requireParentAccess();
  await getFolderAccessStatus(familyId, { force: true });
  revalidatePath("/parent", "layout");
}

/** Type, subject, provenance — manual values are never overwritten by re-indexing (US-2.6 KP-1). */
export async function updateBookAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  registerAll();
  const id = uuidOf(formData, "materialId");
  if (!id) return { status: "error", message: uk.common.error };
  const scope = forFamily(familyId);
  const { data: current } = await scope
    .select("materials", "kind, subject_id")
    .eq("id", id)
    .maybeSingle<{ kind: string; subject_id: string | null }>();
  if (!current) return { status: "error", message: uk.common.error };

  const kind = String(formData.get("kind") ?? "");
  const subjectRaw = String(formData.get("subjectId") ?? "");
  const provenance = String(formData.get("provenance") ?? "").trim().slice(0, 300) || null;
  if (!sourceTypes.has(kind)) return { status: "error", message: uk.common.error };
  let subjectId: string | null = null;
  if (subjectRaw) {
    const { data: subject } = await scope.select("subjects", "id").eq("id", subjectRaw).eq("is_stub", false).maybeSingle();
    if (!subject) return { status: "error", message: uk.common.error };
    subjectId = subjectRaw;
  }
  const patch: Record<string, unknown> = { provenance };
  if (kind !== current.kind) Object.assign(patch, { kind, kind_manual: true });
  if (subjectId !== current.subject_id) Object.assign(patch, { subject_id: subjectId, subject_manual: true });
  const { error } = await scope.update("materials", patch).eq("id", id);
  if (error) return { status: "error", message: uk.common.error };
  revalidatePath("/parent/books", "layout");
  return { status: "ok", message: t.detail.saved };
}

/** Manual fix of one topic (US-2.2 KP-2): marked manual_override, kept by re-indexing. */
export async function updateTopicAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const id = uuidOf(formData, "topicId");
  const title = String(formData.get("title") ?? "").trim().slice(0, 300);
  const num = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 100_000 ? n : NaN;
  };
  const pageFrom = num("pageFrom");
  const pageTo = num("pageTo");
  if (!id || !title || Number.isNaN(pageFrom) || Number.isNaN(pageTo) || (pageFrom && pageTo && pageTo < pageFrom)) {
    return { status: "error", message: uk.common.error };
  }
  const scope = forFamily(familyId);
  const { data: topic, error } = await scope
    .update("topics", { title, page_from: pageFrom, page_to: pageTo, manual_override: true })
    .eq("id", id)
    .select("material_id")
    .maybeSingle<{ material_id: string | null }>();
  if (error || !topic) return { status: "error", message: uk.common.error };
  if (topic.material_id) {
    await scope.client.rpc("assign_chunk_structure", { p_family_id: familyId, p_material_id: topic.material_id });
  }
  revalidatePath("/parent/books", "layout");
  return { status: "ok", message: t.detail.saved };
}

/** Links a (non-textbook) book to topics (US-2.6 KP-1); marks the links as manual. */
export async function saveTopicLinksAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const { familyId } = await requireParentAccess();
  const id = uuidOf(formData, "materialId");
  if (!id) return { status: "error", message: uk.common.error };
  const topicIds = formData
    .getAll("topicIds")
    .map(String)
    .filter((v) => UUID.test(v))
    .slice(0, 200);
  const scope = forFamily(familyId);
  const { data: valid } = topicIds.length
    ? await scope.select("topics", "id").in("id", topicIds).returns<{ id: string }[]>()
    : { data: [] as { id: string }[] };
  const del = await scope.delete("material_topic_links").eq("material_id", id);
  if (del.error) return { status: "error", message: uk.common.error };
  if (valid?.length) {
    const ins = await scope.insert(
      "material_topic_links",
      valid.map((v) => ({ material_id: id, topic_id: v.id, source: "parent" })),
    );
    if (ins.error) return { status: "error", message: uk.common.error };
  }
  await scope.update("materials", { topics_manual: true }).eq("id", id);
  revalidatePath("/parent/books", "layout");
  return { status: "ok", message: t.detail.saved };
}

export interface SearchState {
  status: "idle" | "ok" | "error";
  query?: string;
  hits?: SearchHit[];
  mode?: "hybrid" | "text_only";
}

/** "Перевірити пошук по матеріалах" (US-2.3, demo S1). */
export async function searchBooksAction(_prev: SearchState, formData: FormData): Promise<SearchState> {
  const { familyId } = await requireParentAccess();
  const query = String(formData.get("q") ?? "");
  const subjectId = uuidOf(formData, "subjectId");
  const kindRaw = String(formData.get("kind") ?? "");
  registerAll();
  const kind = sourceTypes.has(kindRaw) ? kindRaw : null;
  try {
    const res = await searchMaterials(familyId, query, { subjectId, kind, limit: 10 });
    return { status: "ok", query, hits: res.hits, mode: res.mode };
  } catch (e) {
    console.error(`search failed: ${(e as Error).message}`);
    return { status: "error", query };
  }
}
