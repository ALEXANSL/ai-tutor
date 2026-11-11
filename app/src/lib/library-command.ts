import type { AudioCard, LibraryBook } from "./audiobooks";
const normalize = (s: string) => s.toLocaleLowerCase("uk").replace(/[«»"'’ʼ.,:;!?]/g, " ").replace(/\s+/g, " ").trim();
/** Resolve only exact available source ranges; never pretend a different chapter is the requested text. */
export function matchLibraryCommand(raw: string, books: LibraryBook[], cards: AudioCard[]) {
  const query = normalize(raw);
  const pages = /сторін(?:ки|ок|ку|ка|ці|ках)?\s*(\d{1,5})(?:\s*(?:[-–—]|до|по)\s*(\d{1,5}))?/u.exec(query);
  const chapterNo = /розділ(?:у|ом|і)?\s*(\d{1,3})/u.exec(query);
  const ignored = new Set(["прочитай", "мені", "будь", "ласка", "книгу", "книга", "роман", "роману", "слухати", "розділ", "розділу", "сторінки", "сторінок", "сторінку", "від", "до", "по", "pdf"]);
  const terms = (query.replace(pages?.[0] ?? /$^/, " ").replace(chapterNo?.[0] ?? /$^/, " ").match(/\p{L}{3,}/gu) ?? []).filter(t => !ignored.has(t));
  const candidates = books.filter(book => !terms.length || terms.every(term => normalize(`${book.title} ${book.author} ${book.chapters.map(c => c.title).join(" ")}`).includes(term.length > 5 ? term.slice(0, -1) : term)));
  if (!candidates.length) return { message: "Не знайшла цю книгу чи розділ у бібліотеці. Спробуй коротшу назву.", books: [] as LibraryBook[], audio: [] as AudioCard[] };
  if (candidates.length > 1 && (pages || chapterNo)) return { message: "Є кілька відповідних книг. Спочатку відкрий потрібну книгу й повтори запит.", books: candidates, audio: [] as AudioCard[] };
  if (!pages && !chapterNo) return { message: "Ось відповідні книги та готове аудіо. Відкрий потрібне для читання.", books: candidates, audio: cards.filter(c => candidates.some(b => b.id === c.materialId) && (!terms.length || normalize(`${c.title} ${c.bookTitle}`).includes(query) || terms.every(t => normalize(`${c.title} ${c.bookTitle}`).includes(t.length > 5 ? t.slice(0, -1) : t)))) };
  const book = candidates[0]!; let from: number, to: number;
  if (pages) {
    if (book.format === "epub") return { message: "EPUB не має сталих друкованих сторінок. Обери розділ у змісті.", books: candidates, audio: [] as AudioCard[] };
    if (!query.includes("pdf") && !book.settings.printedConfirmed) return { message: "Друковану нумерацію ще не підтверджено. Тато може налаштувати її; або вкажи «PDF-сторінки».", books: candidates, audio: [] as AudioCard[] };
    const offset = query.includes("pdf") ? 0 : book.settings.printedOffset; from = Number(pages[1]) + offset; to = Number(pages[2] ?? pages[1]) + offset;
  } else { const chapter = book.chapters[Number(chapterNo![1]) - 1]; if (!chapter) return { message: "Такого розділу в змісті ще немає. Перевір назву або попроси тата уточнити зміст.", books: candidates, audio: [] as AudioCard[] }; from = chapter.from; to = chapter.to; }
  const audio = cards.filter(c => c.materialId === book.id && c.from === from && c.to === to);
  return { message: audio.length ? "Знайшла готове аудіочитання саме цього діапазону. Натисни, щоб слухати." : "Книгу знайдено, але аудіо саме цього розділу або діапазону ще не підготовлено. Попроси тата створити його — вибір дитини не запускає платну генерацію.", books: candidates, audio };
}
