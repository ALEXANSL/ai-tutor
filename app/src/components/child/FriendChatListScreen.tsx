"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { createFriendChatAction, hideFriendChatAction } from "@/app/actions/friend";
import { uk } from "@/i18n/uk";
import type { FriendChatSummary } from "@/server/lessons/friendChat";

export function FriendChatListScreen({ initialChats }: { initialChats: FriendChatSummary[] }) {
  const t = uk.child.friend.list;
  const router = useRouter();
  const [chats, setChats] = useState(initialChats);
  const [pending, setPending] = useState(false);

  async function startNew() {
    if (pending) return;
    setPending(true);
    try {
      const chat = await createFriendChatAction();
      router.push(`/friend/${chat.id}`);
    } finally {
      setPending(false);
    }
  }

  async function hide(chatId: string) {
    if (!window.confirm(t.deleteConfirm)) return;
    setChats((prev) => prev.filter((c) => c.id !== chatId));
    await hideFriendChatAction(chatId);
  }

  return (
    <div className="px-6 pt-4 pb-10">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-extrabold">{t.title}</h1>
        <Link
          href="/today"
          className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold leading-[2.5rem] transition-transform active:scale-[0.97]"
        >
          {t.back}
        </Link>
      </header>

      <button
        type="button"
        disabled={pending}
        onClick={startNew}
        className="mb-4 min-h-12 w-full rounded-2xl bg-primary px-5 text-base font-bold text-white transition-transform active:scale-[0.97] disabled:opacity-60"
      >
        {t.newChat}
      </button>

      {chats.length === 0 ? (
        <p className="text-sm text-muted">{t.empty}</p>
      ) : (
        <ul className="space-y-2.5">
          {chats.map((chat) => (
            <li key={chat.id} className="flex items-center gap-2">
              <Link
                href={`/friend/${chat.id}`}
                className="min-h-12 flex-1 rounded-2xl border-2 border-line bg-surface px-4 py-3 text-[15px] font-bold leading-6 transition-transform active:scale-[0.97]"
              >
                {chat.title}
              </Link>
              <button
                type="button"
                onClick={() => hide(chat.id)}
                className="min-h-12 rounded-2xl border-2 border-line bg-surface px-3.5 text-sm font-bold text-muted transition-transform active:scale-[0.97]"
              >
                {t.delete}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
