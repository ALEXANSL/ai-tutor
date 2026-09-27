"use client";

import Link from "next/link";
import { useState } from "react";
import { askMaterialChatAction } from "@/app/actions/material";
import { uk } from "@/i18n/uk";

interface ChunkView {
  id: string;
  sectionTitle: string | null;
  page: number | null;
  text: string;
}

interface MessageView {
  id: string;
  author: "child" | "ai" | "system" | "parent";
  content: string;
  createdAt: string;
}

/**
 * US-23.1 КП-3/КП-4: sequential reading of an already-indexed "Інше"
 * material (no AI call — the same order indexing stored, `chunks.ordinal`)
 * plus a chat scoped to this one material. Deliberately NOT the lesson
 * screen (docs/04 §11.4's three-column layout) — this is a lighter, no-step,
 * no-progress-bar reading view (7.3: exercises/progress are out of scope
 * for this MVP slice).
 */
export function MaterialReadScreen({
  materialId,
  materialTitle,
  chunks,
  initialMessages,
}: {
  materialId: string;
  materialTitle: string;
  chunks: ChunkView[];
  initialMessages: MessageView[];
}) {
  const t = uk.child.material;
  const [index, setIndex] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState(initialMessages);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);

  const current = chunks[index];

  async function send() {
    const q = question.trim();
    if (!q || pending) return;
    setQuestion("");
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), author: "child", content: q, createdAt: new Date().toISOString() }]);
    setPending(true);
    try {
      const res = await askMaterialChatAction(materialId, materialTitle, q);
      if (res.status === "ok") setMessages((prev) => [...prev, res.message]);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="px-6 pt-5 pb-10">
      <Link href="/today" className="mb-3 inline-block text-sm font-bold text-muted underline">
        {t.back}
      </Link>
      <h1 className="mb-4 text-2xl font-extrabold">{materialTitle}</h1>

      {chunks.length === 0 ? (
        <p className="text-sm text-muted">{t.empty}</p>
      ) : (
        <>
          <div className="rounded-[22px] border border-line bg-surface p-4.5">
            {current?.sectionTitle && <p className="mb-2 text-xs font-bold text-muted">{current.sectionTitle}</p>}
            <p className="whitespace-pre-wrap text-[17px] leading-relaxed">{current?.text}</p>
            {current?.page != null && <p className="mt-3 text-xs text-muted">{t.pageLabel(current.page)}</p>}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              className="min-h-12 rounded-2xl border-2 border-line bg-surface px-4 text-sm font-bold disabled:opacity-40"
            >
              {t.prev}
            </button>
            <span className="text-sm text-muted">{t.pageOf(index + 1, chunks.length)}</span>
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(chunks.length - 1, i + 1))}
              disabled={index === chunks.length - 1}
              className="min-h-12 rounded-2xl border-2 border-line bg-surface px-4 text-sm font-bold disabled:opacity-40"
            >
              {t.next}
            </button>
          </div>
        </>
      )}

      <div className="mt-6">
        <button type="button" onClick={() => setChatOpen((v) => !v)} className="text-sm font-bold text-muted underline">
          {t.chatTitle}
        </button>
        {chatOpen && (
          <div className="mt-2 rounded-2xl border border-line bg-surface p-3.5">
            <div className="mb-2 flex max-h-56 flex-col gap-1.5 overflow-y-auto text-sm">
              {messages.map((m) => (
                <p key={m.id} className={m.author === "child" ? "font-bold" : "text-muted"}>
                  {m.content}
                </p>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder={t.chatPlaceholder}
                className="min-h-12 flex-1 rounded-2xl border-2 border-line bg-bg px-3.5 text-sm outline-none focus:border-focus"
              />
              <button type="button" disabled={pending} onClick={send} className="rounded-2xl bg-primary px-4 text-sm font-bold text-white disabled:opacity-60">
                {t.chatSend}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
