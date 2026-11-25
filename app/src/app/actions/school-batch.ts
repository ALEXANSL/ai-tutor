"use server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { requireParentAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { readSchoolDoc, SCHOOL_ENTRY } from "@/server/eschool/store";
import { forFamily } from "@/server/db/family-scope";
import { startStudio } from "@/server/studio/workflow";
import { kickStudio } from "@/server/studio/wake";
import { STUDIO_MAX_BUDGET, studioRequestSchema } from "@/lib/studio";
import { SCHOOL_BATCH_MAX, schoolStudioRequest } from "@/lib/school-day";
import type { SchoolEntry } from "@/lib/eschool";

const batchSchema = z.object({
  batchId: z.string().uuid(),
  budgetUsd: z.number().min(0.5).max(STUDIO_MAX_BUDGET),
  items: z.array(z.object({ entryId: z.string().uuid(), narratedDeck: z.boolean() }).strict()).min(1).max(SCHOOL_BATCH_MAX),
}).strict();

function uuidFrom(text: string) {
  const bytes = createHash("sha256").update(text).digest().subarray(0, 16); bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type SchoolBatchResult = { entryId: string; status: "ok"; projectId: string } | { entryId: string; status: "error"; message: string };

/** D-136: queue several diary lessons/homework as Studio projects in one go.
 * The parent's explicit click is the launch; each item gets its own project
 * limited by `budgetUsd`. The batch id makes a repeated click idempotent. */
export async function queueSchoolBatchAction(raw: unknown): Promise<{ status: "ok"; results: SchoolBatchResult[] } | { status: "error"; message: string }> {
  const { familyId } = await requireParentAccess();
  let input: z.infer<typeof batchSchema>;
  try { input = batchSchema.parse(raw); } catch { return { status: "error", message: "Перевір список: від 1 до 20 уроків і ліміт на урок від $0.5." }; }
  const { child } = await voiceActor(familyId);
  const year = await forFamily(familyId).select("academic_years", "grade").eq("status", "active").limit(1).maybeSingle<{ grade: number }>();
  const grade = year.data?.grade ?? 6;
  const results: SchoolBatchResult[] = [];
  for (const item of input.items) {
    try {
      const entry = await readSchoolDoc<SchoolEntry>(familyId, child.id, item.entryId, SCHOOL_ENTRY);
      if (!entry) throw new Error("Запис щоденника не знайдено. Онови сторінку.");
      const request = studioRequestSchema.parse(schoolStudioRequest(entry, { narratedDeck: item.narratedDeck, budgetUsd: input.budgetUsd, grade }));
      const projectId = await startStudio(familyId, request, uuidFrom(`school-batch:${familyId}:${input.batchId}:${item.entryId}`));
      kickStudio(familyId, projectId);
      results.push({ entryId: item.entryId, status: "ok", projectId });
    } catch (error) {
      unstable_rethrow(error);
      results.push({ entryId: item.entryId, status: "error", message: error instanceof Error && error.message.length < 300 && !/secret|token|supabase|postgres/i.test(error.message) ? error.message : "Не вдалося поставити в чергу." });
    }
  }
  revalidatePath("/parent/studio");
  return { status: "ok", results };
}
