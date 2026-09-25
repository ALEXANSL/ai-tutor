import Link from "next/link";
import { markAllNotificationsReadAction } from "@/app/actions/parent";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { forFamily, getFamilyTimezone } from "@/server/db/family-scope";
import type { NotificationRow } from "@/server/db/types";
import { PageTitle } from "../ui";

const ICONS: Record<string, string> = {
  nickname_changed: "✏️",
  persona_changed: "🧑‍🏫",
  tutor_name_rejected: "🛑",
  pin_lockout: "🔑",
};
const WITH_CHANGE_BUTTON = new Set(["nickname_changed", "persona_changed", "tutor_name_rejected"]);

function title(n: NotificationRow): string {
  const types = uk.parent.notifications.types;
  const p = n.payload as Record<string, never>;
  switch (n.type) {
    case "nickname_changed":
      return types.nickname_changed(p);
    case "persona_changed":
      return types.persona_changed(p);
    case "tutor_name_rejected":
      return types.tutor_name_rejected(p);
    case "pin_lockout":
      return types.pin_lockout(p);
    default:
      return types.unknown;
  }
}


/** Notification centre (US-11.6): urgent first, unread marked; S0 events have a "Змінити" link. */
export default async function NotificationsPage() {
  const { familyId } = await requireParentAccess();
  const scope = forFamily(familyId);
  const timeFormat = new Intl.DateTimeFormat("uk-UA", {
    timeZone: await getFamilyTimezone(scope),
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const { data } = await scope
    .select("notifications", "id, type, severity, payload, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<NotificationRow[]>();
  const list = [...(data ?? [])].sort((a, b) => Number(b.severity === "urgent") - Number(a.severity === "urgent"));
  const t = uk.parent.notifications;

  return (
    <>
      <PageTitle
        action={
          list.some((n) => !n.read_at) && (
            <form action={markAllNotificationsReadAction}>
              <button type="submit" className="min-h-11 rounded-xl border border-p-line px-3.5 text-[13px] font-bold">
                {t.markAllRead}
              </button>
            </form>
          )
        }
      >
        {t.title}
      </PageTitle>
      {list.length === 0 && <p className="text-p-muted">{t.empty}</p>}
      <ul className="flex flex-col gap-2.5">
        {list.map((n) => (
          <li
            key={n.id}
            className={`flex gap-3.5 rounded-2xl border bg-p-surface px-4.5 py-4 ${n.severity === "urgent" ? "border-2 border-p-danger" : "border-p-line"}`}
          >
            <span className="text-xl" aria-hidden="true">
              {ICONS[n.type] ?? "🔔"}
            </span>
            <div className="flex-1">
              <span className="mr-2 rounded-full bg-p-bg px-2 py-0.5 text-[11px] font-bold text-p-muted">
                {n.severity === "urgent" ? t.tags.urgent : t.tags.system}
              </span>
              <b className="text-[14px]">{title(n)}</b>
              {WITH_CHANGE_BUTTON.has(n.type) && (
                <p className="mt-1 text-[13px]">
                  {n.type === "nickname_changed" && <span className="text-p-muted">{t.nicknameHint} </span>}
                  <Link href="/parent/child" className="font-bold text-p-primary">
                    {t.change}
                  </Link>
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-1 text-xs text-p-muted">
              {!n.read_at && <span className="h-2.5 w-2.5 rounded-full bg-p-primary" aria-label={t.unreadDot} />}
              <time dateTime={n.created_at}>{timeFormat.format(new Date(n.created_at))}</time>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
