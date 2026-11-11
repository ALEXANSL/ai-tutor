"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { studioLessonLinksAction } from "@/app/actions/studio";
import { stopCurrentlyPlaying } from "./singleAudioPlayback";
export function StudioLessonLinks() {
  const pathname = usePathname();
  const [result, setResult] = useState<{ pathname: string; back: string | null; links: { title: string; href: string }[] } | null>(null);
  useEffect(() => { let active = true; void studioLessonLinksAction(pathname).then(value => { if (active) setResult({ pathname, ...value }); }).catch(() => {}); return () => { active = false; }; }, [pathname]);
  if (result?.pathname !== pathname || (!result.back && !result.links.length)) return null;
  const stop = () => { window.dispatchEvent(new Event("lesson-navigation")); stopCurrentlyPlaying(); };
  return <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 px-4 py-2 text-sm">{result.back ? <Link href={result.back} onClick={stop} className="inline-flex min-h-11 items-center rounded-xl border border-secondary bg-surface px-3 font-bold">← Закрити розширення — до базового уроку</Link> : <details className="relative"><summary className="flex min-h-11 cursor-pointer items-center rounded-xl border border-secondary bg-surface px-3 font-bold">Розширені уроки ({result.links.length}) ▾</summary><ul className="absolute left-0 z-50 mt-1 max-h-72 w-[min(320px,85vw)] overflow-y-auto rounded-xl border border-line bg-surface p-2 shadow-lg">{result.links.map(item => <li key={item.href}><Link href={item.href} onClick={stop} className="block rounded-lg px-3 py-3 font-semibold">{item.title}</Link></li>)}</ul></details>}</div>;
}
