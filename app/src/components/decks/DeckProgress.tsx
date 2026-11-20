"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function DeckProgress({ done, scripts, total, nextSlide, hasScript, stage, waiting }: { done: number; scripts: number; total: number; nextSlide: number; hasScript: boolean; stage?: string; waiting?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 6000);
    return () => clearInterval(timer);
  }, [router]);
  return <div role="status" className="space-y-2">
    <p>{!total ? (stage ?? "Готуємо слайди з PowerPoint…") : nextSlide ? `Слайд ${nextSlide} із ${total} · ${hasScript ? "Підготовка аудіозапису" : "Підготовка тексту лектора"}` : "Завершуємо підготовку презентації…"}</p>
    {total > 0 && <p className="text-sm">Текстів підготовлено: {scripts} із {total}. Аудіозаписів готово: {done} із {total}.</p>}
    {!waiting && <progress aria-label="Підготовка текстів і записів" className="w-full" max={total ? total * 2 : 1} value={total ? scripts + done : undefined} />}
  </div>;
}
