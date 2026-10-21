"use server";

import { z } from "zod";
import { requireLessonAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import type { ChildProfileRow } from "@/server/db/types";
import {
  archiveFriendChat, askFriendChat, clearFriendChat, createFriendChat,
  listFriendChatMessages, listFriendChats, renameFriendChat,
} from "@/server/lessons/friendChat";
import { getTutorGender } from "@/server/persona/queries";

async function owner() {
  const { familyId } = await requireLessonAccess();
  const { data, error } = await forFamily(familyId).select("child_profile", "*").maybeSingle<ChildProfileRow>();
  if (error || !data) throw new Error("no child profile in this family yet");
  return { familyId, child: data };
}
const UUID = z.string().uuid();
const titleSchema = z.string().trim().min(1).max(60);
const messageSchema = z.string().trim().min(1).max(800);

export async function loadFriendChatAction(chatId?: string) {
  const { familyId, child } = await owner();
  return listFriendChatMessages(familyId, child.id, chatId === undefined ? undefined : UUID.parse(chatId));
}
export async function listFriendChatsAction() {
  const { familyId, child } = await owner();
  return listFriendChats(familyId, child.id);
}
export async function createFriendChatAction(title?: string) {
  const { familyId, child } = await owner();
  return createFriendChat(familyId, child.id, title === undefined ? undefined : titleSchema.parse(title));
}
export async function renameFriendChatAction(chatId: string, title: string): Promise<void> {
  const { familyId, child } = await owner();
  await renameFriendChat(familyId, child.id, UUID.parse(chatId), titleSchema.parse(title));
}
export async function clearFriendChatAction(chatId: string): Promise<void> {
  const { familyId, child } = await owner();
  await clearFriendChat(familyId, child.id, UUID.parse(chatId));
}
export async function archiveFriendChatAction(chatId: string): Promise<void> {
  const { familyId, child } = await owner();
  await archiveFriendChat(familyId, child.id, UUID.parse(chatId));
}
export async function askFriendChatAction(message: string, chatId?: string) {
  const { familyId, child } = await owner();
  const gender = await getTutorGender(familyId, child);
  const answer = await askFriendChat(familyId, child.id, child.nickname ?? "", child.tutor_name ?? "", gender,
    messageSchema.parse(message), chatId === undefined ? undefined : UUID.parse(chatId));
  return { status: "ok" as const, message: answer };
}
