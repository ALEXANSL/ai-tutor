import { uk } from "@/i18n/uk";
import { parentNav } from "./navigation";

/** Core cabinet sections (docs/04-design-system.md 11.2, mockups 10–17). */
let registered = false;

export function registerCoreNavigation(): void {
  if (registered) return;
  registered = true;
  const n = uk.parent.nav;
  // D-131: six sections; former menu items live on as tabs inside them.
  const items = [
    { key: "dashboard", label: n.dashboard, icon: "📊", href: "/parent", order: 10, badge: "unread_notifications" as const, match: ["/parent/notifications"] },
    { key: "studio", label: n.studio, icon: "✨", href: "/parent/studio", order: 20 },
    { key: "subjects", label: n.subjectsAndCourses, icon: "🎓", href: "/parent/subjects", order: 30, match: ["/parent/courses"] },
    { key: "school", label: n.school, icon: "📅", href: "/parent/school", order: 40 },
    { key: "books", label: n.library, icon: "📚", href: "/parent/books", order: 50, match: ["/parent/library", "/parent/videos", "/parent/audiobooks", "/parent/audio-lessons"] },
    { key: "settings", label: n.family, icon: "⚙️", href: "/parent/settings", order: 60, match: ["/parent/child", "/parent/conversations", "/parent/budget"] },
  ];
  for (const item of items) parentNav.register({ ...item, status: "active" });
  // D-130: inactive "coming soon" placeholders were removed; a future module
  // registers its own item here (parentNav / childTiles) when it ships.
}
