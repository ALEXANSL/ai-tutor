"use server";
import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { STUDIO_PROJECT, STUDIO_STEP } from "@/server/studio/store";
import { kickStudio } from "@/server/studio/wake";
import { STUDIO_REVIEW_EVENT } from "@/server/studio/review-history";
import type { StudioReviewEvent } from "@/lib/studio";
export async function wakeStudioWorkspaceAction() {
  const { familyId } = await requireParentAccess(); const scope = forFamily(familyId);
  const [steps, projects] = await Promise.all([
    scope.select("jobs", "payload").eq("type", STUDIO_STEP).eq("status", "queued").lte("run_after", new Date().toISOString()).limit(100).returns<{ payload: { projectId: string } }[]>(),
    scope.select("jobs", "id,state:payload->>state,stopped:payload->>reviewAutomationStopped").eq("type", STUDIO_PROJECT).in("payload->>state", ["planning", "generating", "publishing", "needs_changes"]).limit(100).returns<{ id: string; state: string; stopped: string | null }[]>(),
  ]);
  if (steps.error || projects.error) throw new Error("Не вдалося перевірити чергу Майстерні.");
  const active = (projects.data ?? []).filter(project => project.state !== "needs_changes" || project.stopped !== "true");
  const ids = new Set((steps.data ?? []).map(step => step.payload.projectId));
  for (const project of active) if (project.state === "needs_changes") ids.add(project.id);
  for (const id of ids) if (/^[a-f0-9-]{36}$/i.test(id)) kickStudio(familyId, id);
  return { active: active.length, checkedAt: new Date().toISOString() };
}
export async function studioReviewHistoryAction(rawId: string, rawPage = 0) {
  const { familyId } = await requireParentAccess(); const id = z.string().uuid().parse(rawId); const page = z.number().int().min(0).max(10000).parse(rawPage);
  const owned = await forFamily(familyId).select("jobs", "id").eq("type", STUDIO_PROJECT).eq("id", id).maybeSingle();
  if (owned.error || !owned.data) throw new Error("Проєкт недоступний.");
  const found = await forFamily(familyId).select("jobs", "payload").eq("type", STUDIO_REVIEW_EVENT).eq("payload->>projectId", id).order("created_at", { ascending: false }).order("id").range(page * 10, page * 10 + 10).returns<{ payload: { event: StudioReviewEvent } }[]>();
  if (found.error) throw new Error("Не вдалося прочитати історію рецензій.");
  return { events: (found.data ?? []).slice(0, 10).map(row => row.payload.event), hasMore: (found.data?.length ?? 0) > 10 };
}
