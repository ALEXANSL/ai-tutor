"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveFriendChatAction,
  askFriendChatAction,
  clearFriendChatAction,
  createFriendChatAction,
  listFriendChatsAction,
  loadFriendChatAction,
  renameFriendChatAction,
} from "@/app/actions/friend";
import { VoiceConversation } from "@/components/voice/VoiceConversation";
import { uk } from "@/i18n/uk";

interface MessageView {
  id: string;
  author: "child" | "ai" | "system" | "parent";
  content: string;
  createdAt: string;
}

interface ChatSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

type Operation = "send" | "switch" | "create" | "rename" | "clear" | "archive";

/** Separate conversations, with the same visible parent-transcript rule as before. */
export function FriendChatScreen({
  initialChatId,
  initialChats,
  initialMessages,
}: {
  initialChatId: string;
  initialChats: ChatSummary[];
  initialMessages: MessageView[];
}) {
  // Import labels here: functions in the dictionary never cross the server/client boundary.
  const t = uk.child.friend;
  const [chats, setChats] = useState(initialChats);
  const [chatId, setChatId] = useState<string | null>(initialChatId);
  const [messages, setMessages] = useState(initialMessages);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<Operation | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"clear" | "archive" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const locked = useRef(false);
  const voiceRunning = useRef(false);
  const generation = useRef(0);
  const activeChat = useRef(chatId);
  const drafts = useRef<Record<string, string>>({});
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "nearest" }); }, [messages, pending]);

  const current = chats.find((chat) => chat.id === chatId);
  const disabled = pending !== null || voiceActive;
  const voiceTarget = useMemo(() => chatId ? { kind: "friend" as const, chatId } : null, [chatId]);
  const handleVoiceActive = useCallback((active: boolean) => {
    voiceRunning.current = active;
    setVoiceActive(active);
  }, []);
  const handleVoiceTurn = useCallback(({ text, message }: { text: string; message: MessageView }) => {
    if (!chatId || activeChat.current !== chatId) return;
    setMessages((prev) => [...prev,
      { id: crypto.randomUUID(), author: "child", content: text, createdAt: new Date().toISOString() },
      message,
    ]);
    setChats((prev) => prev.map((chat) => chat.id === chatId ? {
      ...chat,
      title: chat.title === t.newTitle ? text.slice(0, 60) : chat.title,
      updatedAt: new Date().toISOString(),
    } : chat));
  }, [chatId, t.newTitle]);

  function begin(operation: Operation): number | null {
    if (locked.current || voiceRunning.current) return null;
    locked.current = true;
    const token = ++generation.current;
    setPending(operation);
    setError(null);
    return token;
  }

  function finish(token: number) {
    if (generation.current !== token) return;
    locked.current = false;
    setPending(null);
  }

  function showChat(id: string, nextMessages: MessageView[]) {
    if (activeChat.current) drafts.current[activeChat.current] = question;
    activeChat.current = id;
    setChatId(id);
    setMessages(nextMessages);
    setQuestion(drafts.current[id] ?? "");
    setRenaming(false);
    setConfirmation(null);
  }

  async function selectChat(id: string) {
    if (id === chatId) return;
    const token = begin("switch");
    if (token === null) return;
    try {
      const result = await loadFriendChatAction(id);
      if (generation.current === token) showChat(result.chatId, result.messages);
    } catch {
      if (generation.current === token) setError(t.loadError);
    } finally { finish(token); }
  }

  async function createChat() {
    const token = begin("create");
    if (token === null) return;
    try {
      const chat = await createFriendChatAction();
      if (generation.current !== token) return;
      setChats((prev) => [chat, ...prev]);
      showChat(chat.id, []);
    } catch {
      if (generation.current === token) setError(t.changeError);
    } finally { finish(token); }
  }

  async function send() {
    const text = question.trim();
    if (!text || !chatId || text.length > 800) return;
    const token = begin("send");
    if (token === null) return;
    const targetId = chatId;
    const optimisticId = crypto.randomUUID();
    setQuestion("");
    setMessages((prev) => [...prev, { id: optimisticId, author: "child", content: text, createdAt: new Date().toISOString() }]);
    try {
      const result = await askFriendChatAction(text, targetId);
      if (generation.current !== token || activeChat.current !== targetId) return;
      setMessages((prev) => [...prev, result.message]);
      // A failed refresh must never turn a successfully persisted answer into an unsent message.
      const summaries = await listFriendChatsAction().catch(() => null);
      if (summaries && generation.current === token) setChats(summaries);
    } catch {
      if (generation.current !== token || activeChat.current !== targetId) return;
      // The child turn may already be stored when a provider or reply write fails.
      // Reload the authoritative history before offering the preserved draft again.
      const saved = await loadFriendChatAction(targetId).catch(() => null);
      if (generation.current !== token || activeChat.current !== targetId) return;
      if (saved) setMessages(saved.messages);
      else setMessages((prev) => prev.filter((message) => message.id !== optimisticId));
      setQuestion(text);
      setError(t.sendError);
    } finally { finish(token); }
  }

  async function renameChat() {
    if (!chatId || !name.trim()) return;
    const token = begin("rename");
    if (token === null) return;
    try {
      const title = name.trim();
      await renameFriendChatAction(chatId, title);
      if (generation.current !== token) return;
      setChats((prev) => prev.map((chat) => chat.id === chatId ? { ...chat, title } : chat));
      setRenaming(false);
    } catch {
      if (generation.current === token) setError(t.changeError);
    } finally { finish(token); }
  }

  async function confirmChange() {
    if (!chatId || !confirmation) return;
    const token = begin(confirmation);
    if (token === null) return;
    try {
      if (confirmation === "clear") {
        await clearFriendChatAction(chatId);
        if (generation.current !== token) return;
        setMessages([]);
        setQuestion("");
        setConfirmation(null);
      } else {
        await archiveFriendChatAction(chatId);
        if (generation.current !== token) return;
        const remaining = chats.filter((chat) => chat.id !== chatId);
        setChats(remaining);
        activeChat.current = null;
        setChatId(null);
        setMessages([]);
        setQuestion("");
        setConfirmation(null);
        // Keep a usable empty conversation when the final old conversation is removed.
        if (remaining[0]) {
          const result = await loadFriendChatAction(remaining[0].id);
          if (generation.current === token) showChat(result.chatId, result.messages);
        } else {
          const chat = await createFriendChatAction();
          if (generation.current === token) {
            setChats([chat]);
            showChat(chat.id, []);
          }
        }
      }
    } catch {
      if (generation.current === token) setError(t.changeError);
    } finally { finish(token); }
  }

  return (
    <div className="px-4 pb-6 pt-4 sm:px-6">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h1 className="text-xl font-extrabold">{t.title}</h1>
        <Link href="/today" className="shrink-0 text-sm font-bold text-muted underline">{t.back}</Link>
      </header>
      <p className="mb-4 text-xs text-muted">{t.parentSeesHint}</p>

      <div className="grid items-start gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label={t.conversations} className="min-w-0 rounded-[22px] border border-line bg-surface p-3">
          <button type="button" onClick={createChat} disabled={disabled}
            className="mb-3 min-h-12 w-full rounded-2xl bg-primary px-4 text-base font-bold text-white disabled:opacity-50">
            {pending === "create" ? t.creating : t.newChat}
          </button>
          <label className="block text-sm font-bold md:hidden">
            {t.conversations}
            <select value={chatId ?? ""} disabled={disabled} onChange={(event) => selectChat(event.target.value)}
              className="mt-1 min-h-12 w-full rounded-xl border border-line bg-bg px-3 text-base">
              {!chatId && <option value="">{t.chooseChat}</option>}
              {chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}
            </select>
          </label>
          <div className="hidden max-h-[65vh] space-y-1 overflow-y-auto md:block">
            <p className="mb-2 px-2 text-xs font-bold text-muted">{t.conversations}</p>
            {chats.map((chat) => (
              <button key={chat.id} type="button" aria-current={chat.id === chatId ? "page" : undefined}
                disabled={disabled} onClick={() => selectChat(chat.id)}
                className={`min-h-12 w-full break-words rounded-xl px-3 py-2 text-left text-sm font-semibold disabled:opacity-50 ${chat.id === chatId ? "bg-primary/10 text-primary" : "hover:bg-surface-alt"}`}>
                {chat.title}
              </button>
            ))}
          </div>
        </nav>

        <section aria-label={t.conversation} className="flex min-h-[65vh] min-w-0 flex-col rounded-[22px] border border-line bg-surface p-3 sm:p-4">
          <div className="mb-3 border-b border-line pb-3">
            <h2 className="break-words text-lg font-extrabold">{current?.title ?? t.chooseChat}</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={disabled || !chatId} onClick={() => { setName(current?.title ?? ""); setRenaming(true); setConfirmation(null); }}
                className="min-h-11 rounded-xl border border-line px-3 text-sm font-bold disabled:opacity-50">{t.rename}</button>
              <button type="button" disabled={disabled || !chatId || messages.length === 0} onClick={() => { setConfirmation("clear"); setRenaming(false); }}
                className="min-h-11 rounded-xl border border-line px-3 text-sm font-bold disabled:opacity-50">{t.clear}</button>
              <button type="button" disabled={disabled || !chatId} onClick={() => { setConfirmation("archive"); setRenaming(false); }}
                className="min-h-11 rounded-xl border border-line px-3 text-sm font-bold disabled:opacity-50">{t.archive}</button>
            </div>
          </div>

          {renaming && (
            <form onSubmit={(event) => { event.preventDefault(); void renameChat(); }} className="mb-3 rounded-2xl bg-surface-alt p-3">
              <label className="block text-sm font-bold">{t.nameLabel}
                <input value={name} maxLength={60} disabled={disabled} onChange={(event) => setName(event.target.value)}
                  className="mt-1 min-h-12 w-full rounded-xl border border-line bg-bg px-3 text-base" />
              </label>
              <div className="mt-2 flex gap-2">
                <button type="submit" disabled={disabled || !name.trim()} className="min-h-11 rounded-xl bg-primary px-4 font-bold text-white disabled:opacity-50">{t.save}</button>
                <button type="button" disabled={disabled} onClick={() => setRenaming(false)} className="min-h-11 rounded-xl border border-line px-4 font-bold">{t.cancel}</button>
              </div>
            </form>
          )}
          {confirmation && (
            <div role="alertdialog" aria-labelledby="friend-confirm-title" aria-describedby="friend-confirm-body" className="mb-3 rounded-2xl border border-line bg-surface-alt p-3">
              <h3 id="friend-confirm-title" className="font-bold">{confirmation === "clear" ? t.clearTitle : t.archiveTitle}</h3>
              <p id="friend-confirm-body" className="mt-1 text-sm text-muted">{confirmation === "clear" ? t.clearBody : t.archiveBody}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" disabled={disabled} onClick={confirmChange} className="min-h-11 rounded-xl bg-primary px-4 font-bold text-white disabled:opacity-50">{t.confirm}</button>
                <button type="button" disabled={disabled} onClick={() => setConfirmation(null)} className="min-h-11 rounded-xl border border-line px-4 font-bold">{t.cancel}</button>
              </div>
            </div>
          )}
          {error && <p role="alert" className="mb-3 rounded-xl bg-danger/10 p-3 text-sm font-semibold">{error}</p>}
          <div role="log" aria-label={t.messages} aria-live="polite" aria-busy={pending === "send" || pending === "switch"}
            className="mb-4 max-h-[55vh] flex-1 space-y-3 overflow-y-auto overscroll-contain">
            {messages.length === 0 && <p className="px-1 py-4 text-sm text-muted">{t.empty}</p>}
            {messages.map((message) => (
              <div key={message.id} className={`max-w-[92%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[15px] sm:max-w-[85%] ${message.author === "child" ? "ml-auto bg-primary text-white" : "bg-surface-alt"}`}>
                <span className="sr-only">{message.author === "child" ? t.you : t.assistant}: </span>
                {message.content}
              </div>
            ))}
            {pending && <p role="status" className="px-1 text-sm text-muted">{pending === "send" ? t.thinking : t.updating}</p>}
            <div ref={end} />
          </div>

          {voiceTarget && !pending && <VoiceConversation key={chatId} target={voiceTarget} onTurn={handleVoiceTurn} onActiveChange={handleVoiceActive} />}
          <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="mt-3 flex items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="sr-only">{t.placeholder}</span>
              <textarea value={question} maxLength={800} rows={2} disabled={disabled || !chatId}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
                }}
                placeholder={t.placeholder} className="block min-h-12 w-full resize-y rounded-2xl border-2 border-line bg-bg px-3 py-2.5 text-base outline-none focus:border-focus disabled:opacity-50" />
            </label>
            <button type="submit" disabled={disabled || !chatId || !question.trim()} className="min-h-12 rounded-2xl bg-primary px-4 text-base font-bold text-white disabled:opacity-50">{t.send}</button>
          </form>
          <p className="mt-1 text-right text-xs text-muted">{question.length}/800</p>
        </section>
      </div>
    </div>
  );
}
