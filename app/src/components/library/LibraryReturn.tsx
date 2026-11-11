"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
export function LibraryReturn({ requested }: { requested?: string }) {
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => { const valid = (s: string | null | undefined): s is string => !!s && /^\/(?:lesson|math-course-v2|literature-course-v2|literature-v3|course-lesson|literature)\/[a-f0-9-]{36}$/i.test(s); try { const saved = sessionStorage.getItem("libraryReturn"); if (valid(requested)) { sessionStorage.setItem("libraryReturn", requested); queueMicrotask(() => setHref(requested)); } else if (valid(saved)) queueMicrotask(() => setHref(saved)); } catch { if (valid(requested)) queueMicrotask(() => setHref(requested)); } }, [requested]);
  return href ? <Link href={href} onClick={() => window.dispatchEvent(new Event("lesson-navigation"))} className="inline-flex min-h-11 items-center rounded-xl border border-line px-4 font-bold text-primary">← Повернутися до уроку</Link> : null;
}
