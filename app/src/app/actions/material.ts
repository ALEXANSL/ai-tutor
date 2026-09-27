"use server";

import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { askMaterialChat } from "@/server/lessons/materialChat";

async function onlyChild(familyId: string): Promise<ChildProfileRow> {
  const { data } = await forFamily(familyId).select("child_profile", "*").maybeSingle<ChildProfileRow>();
  if (!data) throw new Error("no child profile in this family yet");
  return data;
}

const UUID = z.string().uuid();
const chatSchema = z.string().trim().min(1).max(800);

/** US-23.1 КП-4: the chat for one "Інше" material, scoped by `material_id` (not `topic_id`). */
export async function askMaterialChatAction(materialId: string, materialTitle: string, question: string) {
  const { familyId } = await requireLessonAccess();
  UUID.parse(materialId);
  const q = chatSchema.parse(question);
  const child = await onlyChild(familyId);
  const message = await askMaterialChat(familyId, child.id, child.nickname ?? "", child.tutor_name ?? "", child.tutor_name_gender, materialId, materialTitle, q);
  return { status: "ok" as const, message };
}
