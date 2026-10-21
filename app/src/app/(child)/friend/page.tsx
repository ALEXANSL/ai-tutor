import { requireChild } from "@/server/auth/guards";
import { listFriendChatMessages, listFriendChats } from "@/server/lessons/friendChat";
import { FriendChatScreen } from "@/components/child/FriendChatScreen";

export const maxDuration = 180;

/** US-8.5/S46: separate friend conversations, with text and voice in each. */
export default async function FriendPage() {
  const { ctx, profile } = await requireChild();
  const { chatId, messages } = await listFriendChatMessages(ctx.familyId, profile.id);
  const chats = await listFriendChats(ctx.familyId, profile.id);
  return (
    <div className="pb-10">
      <FriendChatScreen initialChatId={chatId} initialChats={chats} initialMessages={messages} />
    </div>
  );
}
