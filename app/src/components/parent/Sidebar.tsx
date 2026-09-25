"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { NavItem } from "@/core/registries/navigation";
import { uk } from "@/i18n/uk";

/**
 * Cabinet menu from the navigation registry (docs/04 §11.2, mockup 10).
 * On phones (<820px) it is hidden behind a hamburger with an overlay.
 */
export function Sidebar({
  items,
  unread,
  footer,
}: {
  items: NavItem[];
  unread: number;
  footer: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const t = uk.parent.shell;

  const isActive = (href: string) => (href === "/parent" ? pathname === "/parent" : pathname.startsWith(href));

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t.menu}
        className="fixed top-3 left-3 z-50 flex h-11 w-11 items-center justify-center rounded-xl border border-p-line bg-p-surface text-lg text-p-text min-[820px]:hidden"
      >
        ☰
      </button>
      {open && (
        <div className="fixed inset-0 z-[85] bg-black/45 min-[820px]:hidden" onClick={() => setOpen(false)} aria-hidden="true" />
      )}
      <aside
        className={`${open ? "fixed inset-y-0 left-0 z-[90] flex w-[82vw] max-w-[300px] shadow-2xl" : "hidden"} flex-col gap-1 border-r border-p-line bg-p-surface px-3.5 py-5 min-[820px]:sticky min-[820px]:top-0 min-[820px]:flex min-[820px]:h-screen min-[820px]:w-60`}
      >
        <div className="mb-2 flex justify-end min-[820px]:hidden">
          <button type="button" onClick={() => setOpen(false)} aria-label={t.closeMenu} className="h-11 w-11 text-2xl text-p-muted">
            ✕
          </button>
        </div>
        <div className="flex items-center gap-2.5 px-2.5 pb-4 text-base font-extrabold">
          <span className="h-2.5 w-2.5 rounded-full bg-p-primary" /> {uk.app.name}
        </div>
        <nav className="flex flex-col gap-1" aria-label={t.menu}>
          {items.map((item) =>
            item.href ? (
              <Link
                key={item.key}
                href={item.href}
                onClick={() => setOpen(false)}
                aria-current={isActive(item.href) ? "page" : undefined}
                className={`flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-sm font-semibold ${
                  isActive(item.href) ? "bg-[color-mix(in_srgb,var(--p-primary)_12%,transparent)] text-p-primary" : "text-p-muted"
                }`}
              >
                <span aria-hidden="true">{item.icon}</span> {item.label}
                {item.badge === "unread_notifications" && unread > 0 && (
                  <span className="ml-auto rounded-full bg-p-danger px-2 text-[11px] text-white">{unread}</span>
                )}
              </Link>
            ) : (
              // Inactive placeholder: no link, no tooltip, nothing opens (US-11.8 KP-2).
              <span
                key={item.key}
                aria-disabled="true"
                className="flex min-h-11 cursor-default items-center gap-2.5 rounded-xl px-3 text-sm font-semibold text-p-muted opacity-50 select-none"
              >
                <span aria-hidden="true">{item.icon}</span> {item.label}
              </span>
            ),
          )}
        </nav>
        <div className="mt-auto pt-4">{footer}</div>
      </aside>
    </>
  );
}
