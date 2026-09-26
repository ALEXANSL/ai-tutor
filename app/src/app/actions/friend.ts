"use server";

import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import { askFriendChat, listFriendChatMessages } from "@/server/lessons/friendChat";

async function onlyChild(familyId: string): Promise<ChildProfileRow> {
  const { data } = await forFamily(familyId).select("child_profile", "*").maybeSingle<ChildProfileRow>();
  if (!data) throw new Error("no child profile in this family yet");
  return data;
}

/** US-8.5: "ШІ-друг" — one chat per child, no subject/topic, no time limit (text). */
export async function loadFriendChatAction() {
  const { familyId } = await requireLessonAccess();
  const child = await onlyChild(familyId);
  return listFriendChatMessages(familyId, child.id);
}

const messageSchema = z.string().trim().min(1).max(800);

export async function askFriendChatAction(message: string) {
  const { familyId } = await requireLessonAccess();
  const child = await onlyChild(familyId);
  const text = messageSchema.parse(message);
  const answer = await askFriendChat(familyId, child.id, child.nickname ?? "", child.tutor_name ?? "", child.tutor_name_gender, text);
  return { status: "ok" as const, message: answer };
}
