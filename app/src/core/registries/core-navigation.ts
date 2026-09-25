import { uk } from "@/i18n/uk";
import { childTiles, parentNav } from "./navigation";

/** Core cabinet sections (docs/04-design-system.md 11.2, mockups 10–17). */
let registered = false;

export function registerCoreNavigation(): void {
  if (registered) return;
  registered = true;
  const n = uk.parent.nav;
  const items = [
    { key: "dashboard", label: n.dashboard, icon: "📊", href: "/parent", order: 10 },
    { key: "notifications", label: n.notifications, icon: "🔔", href: "/parent/notifications", order: 20, badge: "unread_notifications" as const },
    { key: "conversations", label: n.conversations, icon: "💬", href: "/parent/conversations", order: 30 },
    { key: "child", label: n.child, icon: "🧒", href: "/parent/child", order: 40 },
    { key: "directives", label: n.directives, icon: "🗒️", href: "/parent/directives", order: 50 },
    { key: "budget", label: n.budget, icon: "💳", href: "/parent/budget", order: 60 },
    { key: "subjects", label: n.subjects, icon: "🎓", href: "/parent/subjects", order: 65 },
    { key: "books", label: n.books, icon: "📚", href: "/parent/books", order: 70 },
    { key: "settings", label: n.settings, icon: "⚙️", href: "/parent/settings", order: 80 },
  ];
  for (const item of items) parentNav.register({ ...item, status: "active" });
  // US-11.8: exactly "Модулі (скоро)", last, inactive, no link/description/dates.
  parentNav.register({ key: "modules", label: n.modulesSoon, icon: "🧩", href: null, status: "soon", order: 1000 });
  childTiles.register({ key: "modules", label: uk.child.today.modulesTile, icon: "🧩", href: null, status: "soon", order: 1000 });
}
