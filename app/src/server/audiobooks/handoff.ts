import "server-only";
import { matchLibraryCommand } from "@/lib/library-command";
export function isLibraryReadingRequest(text: string) {
  return text.length <= 400 && /(?:прочитай|почитай|зачитай|послуха(?:ти|й)|увімкни[^.!?]{0,20}аудіо)/iu.test(text) && /(?:книг|роман|розділ|сторінк|твір|твору|параграф)/iu.test(text) && !/(?:поясни|перекажи|підсумуй|проаналізуй)/iu.test(text);
}
export interface LibraryHandoff { content: string; libraryLink: { href: string; label: string }; }
export async function libraryReadingHandoff(familyId: string, question: string): Promise<LibraryHandoff> {
  try {
    const [{ libraryCatalog }, { listAudioCards }] = await Promise.all([import("./library"), import("./store")]);
    const [books, cards] = await Promise.all([libraryCatalog(familyId), listAudioCards(familyId, undefined, true)]);
    const match = matchLibraryCommand(question, books, cards);
    if (match.audio.length === 1) return { content: "Знайшла готове аудіочитання потрібного матеріалу. Натисни «Слухати книгу». З бібліотеки зможеш повернутися до уроку.", libraryLink: { href: `/audiobooks/${match.audio[0]!.id}`, label: "🎧 Слухати книгу" } };
    return { content: match.message, libraryLink: { href: match.books.length === 1 ? `/library/${match.books[0]!.id}` : "/library", label: "📚 Відкрити бібліотеку" } };
  } catch { return { content: "Пошук у бібліотеці зараз недоступний. Можеш відкрити її окремо й вибрати книгу або готове аудіо.", libraryLink: { href: "/library", label: "📚 Відкрити бібліотеку" } }; }
}
export function validLibraryLink(value: unknown): value is LibraryHandoff["libraryLink"] {
  if (!value || typeof value !== "object") return false;
  const link = value as LibraryHandoff["libraryLink"];
  return typeof link.href === "string" && /^\/(?:library(?:\/[a-f0-9-]{36})?|audiobooks\/[a-f0-9-]{36})$/i.test(link.href) && typeof link.label === "string" && link.label.length <= 80;
}
