"use server";

import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { askFriendChat, createFriendChat, hideFriendChat } from "@/server/lessons/friendChat";

async function onlyChild(familyId: string): Promise<ChildProfileRow> {
  const { data } = await forFamily(familyId).select("child_profile", "*").maybeSingle<ChildProfileRow>();
  if (!data) throw new Error("no child profile in this family yet");
  return data;
}

const messageSchema = z.string().trim().min(1).max(800);
const uuidSchema = z.string().uuid();

/** S46 (2026-10-23, "окремі іменовані чати"): starts a new, separately named chat. */
export async function createFriendChatAction() {
  const { familyId } = await requireLessonAccess();
  const child = await onlyChild(familyId);
  return createFriendChat(familyId, child.id);
}

/** Child-facing "delete" — hides the chat from the child's own list only (КП-3: the parent still sees it). */
export async function hideFriendChatAction(chatId: string) {
  const { familyId } = await requireLessonAccess();
  const child = await onlyChild(familyId);
  await hideFriendChat(familyId, child.id, uuidSchema.parse(chatId));
  return { status: "ok" as const };
}

export async function askFriendChatAction(chatId: string, message: string) {
  const { familyId } = await requireLessonAccess();
  const child = await onlyChild(familyId);
  const text = messageSchema.parse(message);
  const answer = await askFriendChat(familyId, child.id, uuidSchema.parse(chatId), child.nickname ?? "", child.tutor_name ?? "", child.tutor_name_gender, text);
  return { status: "ok" as const, message: answer };
}
