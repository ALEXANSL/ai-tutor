import Link from "next/link";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import { PageTitle, Panel } from "../ui";

interface ChatRow {
  id: string;
  kind: "subject_topic" | "friend" | "private";
  topic_id: string | null;
  topics: { title: string; subjects: { name_uk: string } | { name_uk: string }[] | null } | { title: string; subjects: { name_uk: string } | { name_uk: string }[] | null }[] | null;
}
interface MessageRow {
  id: string;
  author: "child" | "ai" | "system" | "parent";
  content: string;
  created_at: string;
}

/**
 * "Розмови" (US-8.5 КП-3: the parent sees "ШІ-друг" verbatim; US-8.1/8.2
 * topic chats too). Full-text search and date filters (US-8.3, 8.4) are S14
 * — this is the plain, unfiltered reader S4 promises.
 */
export default async function ConversationsPage({ searchParams }: { searchParams: Promise<{ chat?: string }> }) {
  const { chat } = await searchParams;
  const { familyId } = await requireParentAccess();
  const scope = forFamily(familyId);
  const t = uk.parent.conversations;

  const { data: chats } = await scope.client
    .from("chats")
    .select("id, kind, topic_id, topics(title, subjects(name_uk))")
    .eq("family_id", familyId)
    .order("created_at", { ascending: false })
    .returns<ChatRow[]>();

  const list = chats ?? [];
  const activeChatId = chat && list.some((c) => c.id === chat) ? chat : (list[0]?.id ?? null);

  const timeFormat = new Intl.DateTimeFormat("uk-UA", {
    timeZone: await getFamilyTimezone(scope),
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const { data: messages } = activeChatId
    ? await scope.select("messages", "id, author, content, created_at").eq("chat_id", activeChatId).order("created_at").returns<MessageRow[]>()
    : { data: [] as MessageRow[] };

  function labelOf(c: ChatRow): string {
    if (c.kind === "friend") return t.friendChat;
    const topic = Array.isArray(c.topics) ? c.topics[0] : c.topics;
    const subject = topic ? (Array.isArray(topic.subjects) ? topic.subjects[0] : topic.subjects) : null;
    return topic ? `${subject?.name_uk ?? "?"} — ${topic.title}` : t.unknownChat;
  }

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <p className="mb-3 text-[13px] text-p-muted">{t.help}</p>
      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <Panel title={t.listTitle}>
          {list.length === 0 ? (
            <p className="text-[13px] text-p-muted">{t.empty}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {list.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/parent/conversations?chat=${c.id}`}
                    className={`block min-h-11 rounded-xl px-3 py-2 text-[13px] font-bold ${c.id === activeChatId ? "bg-p-primary text-white" : "hover:bg-p-bg"}`}
                  >
                    {labelOf(c)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={activeChatId ? "" : t.pickHint}>
          <div className="flex flex-col gap-2.5">
            {(messages ?? []).map((m) => (
              <div key={m.id} className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[14px] ${m.author === "child" ? "bg-p-bg" : "ml-auto bg-p-primary/10"}`}>
                <p className="mb-1 text-[11px] font-bold text-p-muted">
                  {t.authorLabel[m.author]} · {timeFormat.format(new Date(m.created_at))}
                </p>
                <p className="whitespace-pre-line">{m.content}</p>
              </div>
            ))}
            {activeChatId && (messages ?? []).length === 0 && <p className="text-[13px] text-p-muted">{t.noMessages}</p>}
          </div>
        </Panel>
      </div>
    </>
  );
}
