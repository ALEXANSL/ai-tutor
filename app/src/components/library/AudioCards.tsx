import Link from "next/link";
import type { AudioCard } from "@/lib/audiobooks";
export const audioLabels = { preparing: "Готуємо текст", draft: "Перегляд тексту", generating: "Озвучуємо", ready: "Аудіо готове", paused: "Призупинено", failed: "Потрібна увага", deleting: "Видалення", deleted: "Видалено" };
export function AudioCards({ cards, parent }: { cards: AudioCard[]; parent: boolean }) {
  return <div className="grid gap-3 md:grid-cols-2">{cards.map(card => <Link key={card.id} href={`${parent ? "/parent" : ""}/audiobooks/${card.id}`} className="min-w-0 rounded-2xl border border-line bg-surface p-5"><span className="text-xs font-bold text-muted">🎧 {audioLabels[card.state]}{parent && card.state === "ready" ? card.published ? " · Доступно дитині" : " · Приватна чернетка" : ""}</span><h3 className="mt-2 break-words font-extrabold">{card.title}</h3><p className="mt-1 text-sm text-muted">{card.bookTitle}</p>{card.total > 0 && <p className="mt-2 text-xs text-muted">Аудіофрагментів: {card.ready} / {card.total}</p>}</Link>)}</div>;
}
