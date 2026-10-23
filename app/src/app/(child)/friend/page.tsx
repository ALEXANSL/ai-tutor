import { requireChild } from "@/server/auth/guards";
import { listFriendChats } from "@/server/lessons/friendChat";
import { FriendChatListScreen } from "@/components/child/FriendChatListScreen";

export default async function FriendPage() {
  const { ctx, profile } = await requireChild();
  const chats = await listFriendChats(ctx.familyId, profile.id);
  return (
    <div className="pb-10">
      <FriendChatListScreen initialChats={chats} />
    </div>
  );
}
