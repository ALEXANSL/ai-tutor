"use client";

import Link from "next/link";
import { useState } from "react";
import { askFriendChatAction } from "@/app/actions/friend";
import type { uk } from "@/i18n/uk";

type Labels = typeof uk.child.friend;

interface MessageView {
  id: string;
  author: "child" | "ai" | "system" | "parent";
  content: string;
  createdAt: string;
}

/** US-8.5: no lesson framing at all — just a running chat, text without a time limit. */
export function FriendChatScreen({ initialMessages, labels: t }: { initialMessages: MessageView[]; labels: Labels }) {
  const [messages, setMessages] = useState(initialMessages);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);

  async function send() {
    const text = question.trim();
    if (!text || pending) return;
    setQuestion("");
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), author: "child", content: text, createdAt: new Date().toISOString() }]);
    setPending(true);
    try {
      const res = await askFriendChatAction(text);
      setMessages((prev) => [...prev, res.message]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-[85vh] flex-col px-6 pt-4">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-extrabold">{t.title}</h1>
        <Link href="/today" className="text-sm font-bold text-muted underline">
          {t.back}
        </Link>
      </header>
      <p className="mb-3 text-xs text-muted">{t.parentSeesHint}</p>

      <div className="mb-3 flex-1 space-y-2.5 overflow-y-auto">
        {messages.length === 0 && <p className="text-sm text-muted">{t.empty}</p>}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[15px] ${
              m.author === "child" ? "ml-auto bg-primary text-white" : "bg-surface-alt"
            }`}
          >
            {m.content}
          </div>
        ))}
        {pending && <div className="max-w-[85%] rounded-2xl bg-surface-alt px-3.5 py-2.5 text-[15px] text-muted">{t.thinking}</div>}
      </div>

      <div className="flex gap-2 pb-4">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={t.placeholder}
          className="min-h-12 flex-1 rounded-2xl border-2 border-line bg-bg px-4 text-base outline-none focus:border-focus"
        />
        <button type="button" disabled={pending || !question.trim()} onClick={send} className="min-h-12 rounded-2xl bg-primary px-5 text-base font-bold text-white disabled:opacity-60">
          {t.send}
        </button>
      </div>
    </div>
  );
}
