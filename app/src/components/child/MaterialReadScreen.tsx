"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
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
 * "Jump to…" targets for the sticky nav (fallback for a missing table of
 * contents, per the PO's bug report): grouped by section title when the
 * material has one (already shown per-chunk), otherwise by page number —
 * whichever exists, first chunk of each group wins the jump target.
 */
function buildJumpTargets(chunks: ChunkView[]): { label: string; index: number }[] {
  const bySection = chunks.some((c) => c.sectionTitle);
  const seen = new Set<string | number>();
  const targets: { label: string; index: number }[] = [];
  chunks.forEach((c, index) => {
    // Mixed material (some chunks with a detected sectionTitle, some without,
    // e.g. partially-OCR'd/TOC-detected books): a chunk missing a section
    // title must still get its own reachable entry, falling back to its page
    // number (or, lacking even that, its own index), instead of being
    // silently dropped from the jump list.
    const key = bySection ? (c.sectionTitle ?? `fallback:${c.page ?? index}`) : c.page;
    if (key == null || seen.has(key)) return;
    seen.add(key);
    const label =
      bySection && c.sectionTitle
        ? uk.child.material.jumpToSection(c.sectionTitle)
        : c.page != null
          ? uk.child.material.jumpToPage(c.page)
          : uk.child.material.pageOf(index + 1, chunks.length);
    targets.push({ label, index });
  });
  return targets;
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
  partiallyIndexed = false,
}: {
  materialId: string;
  materialTitle: string;
  chunks: ChunkView[];
  initialMessages: MessageView[];
  partiallyIndexed?: boolean;
}) {
  const t = uk.child.material;
  const [index, setIndex] = useState(0);
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState(initialMessages);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);

  const current = chunks[index];
  const jumpTargets = useMemo(() => buildJumpTargets(chunks), [chunks]);

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
    <div className="pb-10">
      {chunks.length > 0 && (
        <div className="sticky top-20 z-40 border-b border-line bg-bg px-6 py-2.5">
          {/* Fixed/sticky nav (bug report): prev/next + page indicator no
              longer sit below the content, where a shorter/longer chunk made
              them jump up and down the screen every time the child navigated.
              top-20 (not top-0): (child)/layout.tsx renders ThemeToggle
              `fixed top-3.5 right-3.5 z-50` on every child page, above this
              bar's z-40. ThemeToggle's real footprint (Tailwind px values:
              top-3.5=14px, container p-1=4px, button min-h-9=36px) bottom
              edge is 14+4+36+4=58px from the viewport top, and its two
              buttons ("☀️ Світла" / "🌙 Темна") are wide enough to sit
              directly over this bar's right-aligned "Далі →" button once
              this bar sticks to top-0 — which is exactly the "navigation
              intercepts taps" collision reported. top-20 (80px) keeps the
              whole bar, in every scroll position (sticky clamps the initial,
              unscrolled layout too, not just while scrolling), below
              ThemeToggle's footprint with a safety margin, so nothing here
              is ever under it. No other child screen has sticky content
              yet (checked: no other component in src/components/child uses
              `sticky`), so there was no existing pattern to reuse. */}
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              className="min-h-11 rounded-xl border-2 border-line bg-surface px-3 text-sm font-bold disabled:opacity-40"
            >
              {t.prev}
            </button>
            <span className="text-xs text-muted">{t.pageOf(index + 1, chunks.length)}</span>
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(chunks.length - 1, i + 1))}
              disabled={index === chunks.length - 1}
              className="min-h-11 rounded-xl border-2 border-line bg-surface px-3 text-sm font-bold disabled:opacity-40"
            >
              {t.next}
            </button>
          </div>
          {jumpTargets.length > 1 && (
            <select
              aria-label={t.jumpLabel}
              value={index}
              onChange={(e) => setIndex(Number(e.target.value))}
              className="mt-2 min-h-11 w-full rounded-xl border-2 border-line bg-surface px-3 text-sm font-bold"
            >
              {jumpTargets.map((target) => (
                <option key={target.index} value={target.index}>
                  {target.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      <div className="px-6 pt-4">
        <Link href="/today" className="mb-3 inline-block text-sm font-bold text-muted underline">
          {t.back}
        </Link>
        <h1 className="mb-4 text-2xl font-extrabold">{materialTitle}</h1>
        {partiallyIndexed && <p className="mb-4 rounded-2xl bg-warn/20 px-3.5 py-2.5 text-xs font-semibold">{t.partiallyIndexed}</p>}

        {chunks.length === 0 ? (
          <p className="text-sm text-muted">{t.empty}</p>
        ) : (
          <div className="rounded-[22px] border border-line bg-surface p-4.5">
            {current?.sectionTitle && <p className="mb-2 text-xs font-bold text-muted">{current.sectionTitle}</p>}
            <p className="whitespace-pre-wrap text-[17px] leading-relaxed">{current?.text}</p>
            {current?.page != null && <p className="mt-3 text-xs text-muted">{t.pageLabel(current.page)}</p>}
          </div>
        )}
      </div>

      <div className="mt-6 px-6">
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
