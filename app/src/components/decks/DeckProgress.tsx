"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
export function DeckProgress({ done, total }: { done: number; total: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(timer);
  }, [router]);
  return <div role="status" className="space-y-2"><p>{total ? `Готуємо озвучення · готово ${done} із ${total} слайдів` : "Готуємо слайди з PowerPoint…"} Можна закрити сторінку.</p><progress className="w-full" max={total || 1} value={total ? done : undefined} /></div>;
}
