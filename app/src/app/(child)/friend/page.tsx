import { requireChild } from "@/server/auth/guards";
import { listFriendChatMessages } from "@/server/lessons/friendChat";
import { FriendChatScreen } from "@/components/child/FriendChatScreen";

/** US-8.5: "ШІ-друг" — free-topic chat, text without a time limit (PM-2, "будь-коли"). */
export default async function FriendPage() {
  const { ctx, profile } = await requireChild();
  const { messages } = await listFriendChatMessages(ctx.familyId, profile.id);
  return (
    <div className="pb-10">
      <FriendChatScreen initialMessages={messages} />
    </div>
  );
}
