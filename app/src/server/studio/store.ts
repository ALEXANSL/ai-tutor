import "server-only";
import { readStoredUnits, writeStoredUnits } from "./unit-store";
import { forFamily } from "@/server/db/family-scope";
import type { StudioProject } from "@/lib/studio";
export const STUDIO_PROJECT = "studio.project";
export const STUDIO_STEP = "studio.step";
export async function createStudioProject(familyId: string, project: StudioProject, id: string): Promise<string> {
  const { data, error } = await forFamily(familyId).insert("jobs", { id, type: STUDIO_PROJECT, status: "done", payload: project }).select("id").single<{ id: string }>();
  if (error?.code === "23505") { const existing = await readStudioProject(familyId, id); if (existing && JSON.stringify(existing.request) === JSON.stringify(project.request)) return id; }
  if (error || !data) throw new Error("Не вдалося зберегти чернетку майстерні."); return data.id;
}
export async function readStudioProject(familyId: string, id: string): Promise<StudioProject | null> {
  const { data, error } = await forFamily(familyId).select("jobs", "payload").eq("id", id).eq("type", STUDIO_PROJECT).maybeSingle<{ payload: StudioProject }>();
  if (error) throw new Error("Не вдалося прочитати майстерню.");
  const project = data?.payload?.version === 1 ? data.payload : null;
  return project?.unitRefs ? { ...project, units: await readStoredUnits(familyId, id, project.unitRefs) } : project;
}
/** CAS protects edits, budget reservations and checkpoints from concurrent clicks/workers. */
export async function saveStudioProject(familyId: string, id: string, previous: StudioProject, changes: Partial<StudioProject>): Promise<StudioProject> {
  const next = { ...previous, ...changes, revision: previous.revision + 1 };
  let stored = next;
  if (next.unitRefs || next.request.lessonCount > 6 || Buffer.byteLength(JSON.stringify(next)) > 800000) {
    const refs = await writeStoredUnits(familyId, id, next.units, previous.unitRefs);
    next.unitRefs = refs; stored = { ...next, unitRefs: refs, units: [] };
  }
  if (Buffer.byteLength(JSON.stringify(stored)) > 2000000) throw new Error("План або джерела чернетки завеликі. Скороти описи плану чи джерела; готові уроки збережено.");
  const { data, error } = await forFamily(familyId).update("jobs", { payload: stored }).eq("id", id).eq("type", STUDIO_PROJECT).eq("payload->>revision", String(previous.revision)).select("id").maybeSingle<{ id: string }>();
  if (error || !data) throw new Error("Чернетку вже змінено. Онови сторінку перед повторною дією."); return next;
}
export async function listStudioProjects(familyId: string, publishedOnly = false): Promise<{ id: string; project: StudioProject }[]> {
  let query = forFamily(familyId).select("jobs", "id,payload").eq("type", STUDIO_PROJECT);
  if (publishedOnly) query = query.eq("payload->>state", "published");
  const { data, error } = await query.order("created_at", { ascending: false }).limit(100).returns<{ id: string; payload: StudioProject }[]>();
  if (error) throw new Error("Не вдалося прочитати список майстерні.");
  return (data ?? []).filter(row => row.payload?.version === 1).map(row => ({ id: row.id, project: row.payload }));
}
