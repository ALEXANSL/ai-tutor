import { notFound } from "next/navigation";
import { requireChild } from "@/server/auth/guards";
import { listFriendChatMessages } from "@/server/lessons/friendChat";
import { FriendChatScreen } from "@/components/child/FriendChatScreen";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function FriendChatPage({ params }: { params: Promise<{ chatId: string }> }) {
  const { chatId } = await params;
  if (!UUID.test(chatId)) notFound();
  const { ctx, profile } = await requireChild();
  let messages;
  try {
    messages = await listFriendChatMessages(ctx.familyId, profile.id, chatId);
  } catch {
    notFound();
  }
  return (
    <div className="pb-10">
      <FriendChatScreen chatId={chatId} initialMessages={messages} />
    </div>
  );
}
