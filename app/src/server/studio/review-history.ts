import "server-only";
import { createHash } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import type { StudioReviewEvent } from "@/lib/studio";
export const STUDIO_REVIEW_EVENT = "studio.review_event";
export async function saveStudioReviewEvent(familyId: string, projectId: string, token: string, revision: number, event: StudioReviewEvent) {
  const hex = createHash("sha256").update(`${familyId}:${projectId}:${token}:${revision}:review`).digest("hex");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const saved = await forFamily(familyId).upsert("jobs", { id, type: STUDIO_REVIEW_EVENT, status: "done", payload: { projectId, event } }, "id");
  if (saved.error) throw new Error("Не вдалося зберегти журнал рецензії.");
}
