"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * D-131: the cabinet menu has six sections; screens that used to be separate
 * menu items are tabs inside their section. One definition per section keeps
 * every page of the section showing the same tabs in the same order.
 */
export const SECTION_TABS = {
  subjects: [
    { href: "/parent/subjects", label: "Шкільні предмети" },
    { href: "/parent/courses", label: "Курси" },
  ],
  library: [
    { href: "/parent/catalog", label: "Усі матеріали" },
    { href: "/parent/books", label: "Книги та джерела" },
    { href: "/parent/library", label: "Аудіо" },
    { href: "/parent/videos", label: "Відео" },
  ],
  family: [
    { href: "/parent/settings", label: "Налаштування" },
    { href: "/parent/child", label: "Профіль дитини" },
    { href: "/parent/conversations", label: "Розмови" },
    { href: "/parent/budget", label: "Бюджет і моделі" },
  ],
} as const;

export type SectionKey = keyof typeof SECTION_TABS;

export function activeSectionTab(section: SectionKey, pathname: string): string | null {
  const tab = SECTION_TABS[section].find((t) => pathname === t.href || pathname.startsWith(`${t.href}/`));
  return tab?.href ?? null;
}

export function SectionTabs({ section }: { section: SectionKey }) {
  const pathname = usePathname();
  const active = activeSectionTab(section, pathname);
  return (
    <nav aria-label="Вкладки розділу" className="mb-5 flex flex-wrap gap-2">
      {SECTION_TABS[section].map((tab) => {
        const current = tab.href === active;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? "page" : undefined}
            className={`inline-flex min-h-11 items-center rounded-xl border px-3.5 text-sm font-bold ${
              current ? "border-p-primary bg-[color-mix(in_srgb,var(--p-primary)_12%,transparent)] text-p-primary" : "border-p-line text-p-muted"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
