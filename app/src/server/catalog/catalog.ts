import "server-only";
import { createHash } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import { getActiveImportedLessonsForTopics } from "@/server/subjects/queries";
import { listVideoLibrary } from "@/server/lessons/videoLessons";
import { listAudioCards } from "@/server/audiobooks/store";
import { listBooks } from "@/server/books/queries";
import { DECK_TYPE } from "@/server/decks/store";
import { DECK_IMAGE_BUCKET } from "@/server/decks/visuals";
import type { CatalogItem, CatalogStatus } from "@/lib/catalog";
import type { AudioCard } from "@/lib/audiobooks";

/**
 * D-142: archive marks live in `jobs` rows (status "done", like the other
 * key-value records there), so archiving needs no SQL migration. Archiving
 * only hides a material in the parent catalog; nothing is deleted and the
 * child's screens do not change.
 */
export const ARCHIVE_TYPE = "catalog.archive";
const COVER_TTL_S = 3600;
const IN_CHUNK = 150;

export function archiveRowId(familyId: string, key: string) {
  const h = createHash("sha256").update(`${familyId}:${ARCHIVE_TYPE}:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export async function listArchivedKeys(familyId: string): Promise<Set<string>> {
  const { data, error } = await forFamily(familyId).select("jobs", "key:payload->>key").eq("type", ARCHIVE_TYPE).limit(5000).returns<{ key: string }[]>();
  if (error) throw new Error("Не вдалося прочитати архів матеріалів.");
  return new Set((data ?? []).map(row => row.key));
}

export async function setArchived(familyId: string, keys: string[], archived: boolean) {
  const scope = forFamily(familyId);
  if (!keys.length) return;
  if (archived) {
    const archivedAt = new Date().toISOString();
    const { error } = await scope.upsert("jobs", keys.map(key => ({ id: archiveRowId(familyId, key), type: ARCHIVE_TYPE, status: "done", payload: { key, archivedAt } })), "id");
    if (error) throw new Error("Не вдалося перенести в архів. Спробуй ще раз.");
  } else {
    const { error } = await scope.delete("jobs").eq("type", ARCHIVE_TYPE).in("id", keys.map(key => archiveRowId(familyId, key)));
    if (error) throw new Error("Не вдалося повернути з архіву. Спробуй ще раз.");
  }
}

type SubjectRow = { id: string; name_uk: string; active: boolean };
type TopicRow = { id: string; title: string; subject_id: string; grade: number | null; created_at: string };
type DeckRow = { id: string; created_at: string; title: string | null; state: string | null; published: string | null; subjectId: string | null; topicId: string | null; videoState: string | null; slides: { visual?: { kind?: string; path?: string } }[] | null };

async function pages<T>(load: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, message: string): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const { data, error } = await load(offset, offset + 999);
    if (error) throw new Error(message);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

function chunks<T>(list: T[], size: number) { const out: T[][] = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; }

/** First real picture of the deck: a scene or photo before a map. */
export function deckCoverPath(slides: DeckRow["slides"]): string | null {
  const visuals = (Array.isArray(slides) ? slides : []).map(slide => slide?.visual).filter(visual => visual?.path && visual.kind !== "none");
  return (visuals.find(visual => visual!.kind !== "map") ?? visuals[0])?.path ?? null;
}

const deckStatus = (row: DeckRow): CatalogStatus => row.state === "error" ? "attention" : row.state === "ready" ? (row.published === "true" ? "child" : "review") : "preparing";
const audioStatus = (card: AudioCard): CatalogStatus => card.state === "failed" ? "attention" : card.state === "ready" ? (card.published ? "child" : "review") : card.state === "paused" || card.state === "draft" ? "review" : "preparing";
const bookStatus = (status: string): CatalogStatus => ["ready", "ready_partial"].includes(status) ? "ready" : ["error", "scan_no_text", "scan_awaiting_ocr"].includes(status) ? "attention" : "preparing";

export async function loadCatalog(familyId: string): Promise<CatalogItem[]> {
  const scope = forFamily(familyId);
  const [subjects, topics, decks, videos, audio, books, archived] = await Promise.all([
    pages<SubjectRow>((a, b) => scope.select("subjects", "id, name_uk, active").order("id").range(a, b).returns<SubjectRow[]>(), "Не вдалося прочитати предмети."),
    pages<TopicRow>((a, b) => scope.select("topics", "id, title, subject_id, grade, created_at").order("id").range(a, b).returns<TopicRow[]>(), "Не вдалося прочитати уроки."),
    pages<DeckRow>((a, b) => scope.select("jobs", "id,created_at,title:payload->>title,state:payload->>state,published:payload->>published,subjectId:payload->>subjectId,topicId:payload->>topicId,videoState:payload->video->>state,slides:payload->generated->plan->slides").eq("type", DECK_TYPE).order("id").range(a, b).returns<DeckRow[]>(), "Не вдалося прочитати презентації."),
    listVideoLibrary(familyId),
    listAudioCards(familyId),
    listBooks(familyId),
    listArchivedKeys(familyId),
  ]);
  const subjectById = new Map(subjects.map(subject => [subject.id, subject]));
  const topicById = new Map(topics.map(topic => [topic.id, topic]));
  const lessonByTopic = new Map<string, unknown>();
  for (const part of chunks(topics.map(topic => topic.id), IN_CHUNK)) for (const [id, lesson] of await getActiveImportedLessonsForTopics(familyId, part)) lessonByTopic.set(id, lesson);

  const coverPaths = decks.map(deck => deckCoverPath(deck.slides)).filter((path): path is string => !!path);
  const signed = new Map<string, string>();
  for (const part of chunks([...new Set(coverPaths)], 100)) {
    const { data } = await scope.client.storage.from(DECK_IMAGE_BUCKET).createSignedUrls(part, COVER_TTL_S);
    for (const entry of data ?? []) if (entry.path && entry.signedUrl) signed.set(entry.path, entry.signedUrl);
  }
  // A lesson shows the cover of its own presentation, when it has one.
  const coverByTopic = new Map<string, string>();
  for (const deck of decks) { const path = deckCoverPath(deck.slides); const url = path ? signed.get(path) : undefined; if (deck.topicId && url && !coverByTopic.has(deck.topicId)) coverByTopic.set(deck.topicId, url); }

  const subjectOf = (id: string | null | undefined) => (id ? subjectById.get(id) : undefined);
  const items: Omit<CatalogItem, "archived">[] = [];
  for (const topic of topics) {
    if (!lessonByTopic.has(topic.id)) continue;
    const subject = subjectOf(topic.subject_id);
    items.push({ key: `lesson:${topic.id}`, kind: "lesson", title: topic.title, subjectId: topic.subject_id, subjectName: subject?.name_uk ?? null, topicTitle: null, grade: topic.grade, createdAt: topic.created_at, status: subject?.active === false ? "off" : "child", href: `/parent/subjects/${topic.subject_id}`, cover: coverByTopic.get(topic.id) ?? null, notes: [] });
  }
  for (const deck of decks) {
    const topic = deck.topicId ? topicById.get(deck.topicId) : undefined;
    const subjectId = deck.subjectId ?? topic?.subject_id ?? null;
    const path = deckCoverPath(deck.slides);
    items.push({ key: `presentation:${deck.id}`, kind: "presentation", title: deck.title || "Презентація без назви", subjectId, subjectName: subjectOf(subjectId)?.name_uk ?? null, topicTitle: topic && topic.title !== deck.title ? topic.title : null, grade: topic?.grade ?? null, createdAt: deck.created_at, status: deckStatus(deck), href: `/parent/studio/presentations/${deck.id}`, cover: path ? signed.get(path) ?? null : null, notes: [...(Array.isArray(deck.slides) ? [`Слайдів: ${deck.slides.length}`] : []), ...(deck.videoState === "ready" ? ["Є відео MP4"] : [])] });
  }
  for (const video of videos) {
    const topic = topicById.get(video.topicId);
    items.push({ key: `video:${video.id}`, kind: "video", title: video.topicTitle, subjectId: video.subjectId, subjectName: video.subjectName, topicTitle: null, grade: topic?.grade ?? null, createdAt: video.createdAt, status: subjectOf(video.subjectId)?.active === false ? "off" : "child", href: `/parent/videos?subject=${video.subjectId}`, cover: coverByTopic.get(video.topicId) ?? null, notes: [`${(video.sizeBytes / 1024 / 1024).toFixed(1)} МБ`] });
  }
  const bookById = new Map(books.map(book => [book.id, book]));
  for (const card of audio) {
    const topic = card.lessonTopicId ? topicById.get(card.lessonTopicId) : undefined;
    const subjectId = topic?.subject_id ?? bookById.get(card.materialId)?.subjectId ?? null;
    items.push({ key: `audio:${card.id}`, kind: "audio", title: card.title || "Аудіо без назви", subjectId, subjectName: subjectOf(subjectId)?.name_uk ?? null, topicTitle: card.bookTitle && card.bookTitle !== card.title ? card.bookTitle : null, grade: topic?.grade ?? null, createdAt: card.createdAt, status: audioStatus(card), href: `/parent/audiobooks/${card.id}`, cover: topic ? coverByTopic.get(topic.id) ?? null : null, notes: card.total > 0 ? [`Фрагментів: ${card.ready} з ${card.total}`] : [] });
  }
  for (const book of books) {
    items.push({ key: `book:${book.id}`, kind: "book", title: book.title || book.name, subjectId: book.subjectId, subjectName: subjectOf(book.subjectId)?.name_uk ?? null, topicTitle: null, grade: null, createdAt: book.addedAt, status: bookStatus(book.status), href: `/parent/books/${book.id}`, cover: null, notes: [book.format === "manual" ? "Набір файлів" : book.format.toUpperCase(), ...(book.pageCount ? [`${book.pageCount} с.`] : [])] });
  }
  return items.map(item => ({ ...item, archived: archived.has(item.key) }));
}
