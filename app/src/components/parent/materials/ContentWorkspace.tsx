"use client";
import { useId, useState, type ReactNode } from "react";
import { isAppBusy } from "@/lib/busy-signal";

export const contentSections = [
  { key: "course", title: "Курс ZIP", detail: "Готові уроки одним архівом", number: "01" },
  { key: "video", title: "Відео", detail: "Доповнення до теми уроку", number: "02" },
  { key: "book", title: "Підручник або книга", detail: "PDF / EPUB як джерело", number: "03" },
  { key: "materials", title: "Додаткові матеріали", detail: "Посібники та довідники", number: "04" },
] as const;
export type ContentSection = typeof contentSections[number]["key"];

/** Keep mounted importers so switching intent never discards an archive, draft or result. */
export function ContentWorkspace({ initialSection = "course", children }: { initialSection?: ContentSection; children: Record<ContentSection, ReactNode> }) {
  const [active, setActive] = useState(initialSection);
  const [notice, setNotice] = useState("");
  const id = useId();
  function choose(key: ContentSection) {
    if (isAppBusy()) { setNotice("Зачекай завершення поточного завантаження чи перевірки, щоб змінити розділ."); return; }
    setNotice(""); setActive(key);
    const url = new URL(window.location.href); url.searchParams.set("tab", key); window.history.replaceState(null, "", url);
  }
  return <div>
    <div role="tablist" aria-label="Що потрібно додати" className="mb-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
      {contentSections.map((item, index) => <button key={item.key} id={`${id}-${item.key}`} role="tab" type="button" aria-selected={active === item.key} aria-controls={`${id}-${item.key}-panel`} tabIndex={active === item.key ? 0 : -1}
        onClick={() => choose(item.key)} onKeyDown={event => {
          const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          const next = event.key === "Home" ? 0 : event.key === "End" ? contentSections.length - 1 : delta ? (index + delta + contentSections.length) % contentSections.length : -1;
          if (next < 0) return; event.preventDefault(); const key = contentSections[next]!.key; choose(key); document.getElementById(`${id}-${key}`)?.focus();
        }} className={`min-h-24 min-w-0 rounded-2xl border p-3 text-left transition-colors ${active === item.key ? "border-p-primary bg-[color-mix(in_srgb,var(--p-primary)_8%,var(--p-surface))]" : "border-p-line bg-p-surface hover:border-p-primary"}`}>
        <span aria-hidden="true" className="mb-2 block text-xs font-bold text-p-muted">{item.number}</span><span className={`block text-sm font-bold ${active === item.key ? "text-p-primary" : "text-p-text"}`}>{item.title}</span><span className="mt-1 block text-xs leading-relaxed text-p-muted">{item.detail}</span>
      </button>)}
    </div>
    {notice && <p role="status" className="mb-3 text-sm text-p-muted">{notice}</p>}
    {contentSections.map(item => <div key={item.key} role="tabpanel" id={`${id}-${item.key}-panel`} aria-labelledby={`${id}-${item.key}`} hidden={active !== item.key}>{children[item.key]}</div>)}
  </div>;
}
