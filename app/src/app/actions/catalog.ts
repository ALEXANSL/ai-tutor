"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireParentAccess } from "@/server/auth/guards";
import { setArchived } from "@/server/catalog/catalog";
import { ARCHIVE_KEY } from "@/lib/catalog";

const input = z.object({ keys: z.array(z.string().regex(ARCHIVE_KEY)).min(1).max(200), archived: z.boolean() });
export type ArchiveResult = { status: "ok" } | { status: "error"; message: string };

/** D-142: archive hides a material in the parent catalog without deleting it. */
export async function setCatalogArchivedAction(keys: string[], archived: boolean): Promise<ArchiveResult> {
  const { familyId } = await requireParentAccess();
  const parsed = input.safeParse({ keys, archived });
  if (!parsed.success) return { status: "error", message: "Не вдалося розпізнати вибрані матеріали. Онови сторінку." };
  try { await setArchived(familyId, [...new Set(parsed.data.keys)], parsed.data.archived); }
  catch (error) { return { status: "error", message: error instanceof Error ? error.message : "Дію не виконано. Спробуй ще раз." }; }
  revalidatePath("/parent/catalog");
  return { status: "ok" };
}
