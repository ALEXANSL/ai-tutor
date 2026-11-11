"use client";
import Link from "next/link";
export function LibraryReadingLink({ link }: { link: { href: string; label: string } }) {
  if (!/^\/(?:library(?:\/[a-f0-9-]{36})?|audiobooks\/[a-f0-9-]{36})$/i.test(link.href)) return null;
  return <Link href={link.href} className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-secondary px-4 font-bold text-secondary" onClick={() => { const path = location.pathname; if (/^\/(?:lesson|math-course-v2|literature-course-v2|literature-v3|course-lesson|literature)\/[a-f0-9-]{36}$/i.test(path)) { try { sessionStorage.setItem("libraryReturn", path); } catch {} } window.dispatchEvent(new Event("lesson-navigation")); }}>{link.label}</Link>;
}
