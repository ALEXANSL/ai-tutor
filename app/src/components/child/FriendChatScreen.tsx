"use client";

import Link from "next/link";
import { useState } from "react";
import { askFriendChatAction } from "@/app/actions/friend";
import { VoiceConversation } from "@/components/voice/VoiceConversation";
import { uk } from "@/i18n/uk";
import type { VoiceTurn } from "@/lib/voice";

interface MessageView {
  id: string;
  author: "child" | "ai" | "system" | "parent";
  content: string;
  createdAt: string;
}

// BUG-017: same class of bug as the lesson screen — `uk.child.friend` is
// imported directly here (client module) rather than passed down as a
// `labels` prop from the server component in `page.tsx`, so a function
// added to that namespace later can never re-trigger "Functions cannot be
// passed directly to Client Components".
/** US-8.5: no lesson framing at all — just a running chat, text without a time limit. */
export function FriendChatScreen({ initialMessages }: { initialMessages: MessageView[] }) {
  const t = uk.child.friend;
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

  // US-8.5 follow-up (Алекс 2026-10-22, "голосовий режим у чаті"): a voice
  // turn is appended into the SAME thread as typed messages (both the
  // child's recognized speech and the reply) — unlike a lesson screen,
  // this whole screen IS the conversation, so a separate mini-transcript
  // (`LessonVoicePanel`'s own, used everywhere else) would just duplicate it.
  function onVoiceTurn(turn: VoiceTurn) {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), author: "child", content: turn.text, createdAt: new Date().toISOString() },
      turn.message,
    ]);
  }

  return (
    <div className="flex min-h-[85vh] flex-col px-6 pt-4">
      <header className="mb-3 flex items-center justify-between">
        <h1 className="text-xl font-extrabold">{t.title}</h1>
        <Link
          href="/today"
          className="min-h-11 rounded-full border-2 border-line bg-surface px-3.5 text-sm font-bold leading-[2.5rem] transition-transform active:scale-[0.97]"
        >
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
        {pending && (
          <div className="max-w-[85%] rounded-2xl bg-surface-alt px-3.5 py-2.5 text-[15px] text-muted" role="status" aria-label={t.thinking}>
            <span className="typing-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
      </div>

      <VoiceConversation target={{ kind: "friend" }} onTurn={onVoiceTurn} />

      <div className="flex gap-2 pb-4">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={t.placeholder}
          className="min-h-12 flex-1 rounded-2xl border-2 border-line bg-bg px-4 text-base outline-none focus:border-focus"
        />
        <button
          type="button"
          disabled={pending || !question.trim()}
          onClick={send}
          className="min-h-12 rounded-2xl bg-primary px-5 text-base font-bold text-white transition-transform active:scale-[0.97] disabled:opacity-60"
        >
          {t.send}
        </button>
      </div>
    </div>
  );
}
