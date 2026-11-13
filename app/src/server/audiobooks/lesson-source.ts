import "server-only";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { studioPublicationsForSubject } from "@/server/studio/links";
import { loadVideoLessonSource } from "@/server/video-script/source";
import type { AudioRequest, LibraryBook } from "@/lib/audiobooks";
import { defaultLibrarySettings } from "./store";
export async function audioLessonOptions(familyId: string, subjectId: string) {
  const subject = await getSubjectDetail(familyId, subjectId); if (!subject) throw new Error("Предмет не знайдено.");
  const publications = await studioPublicationsForSubject(familyId, subjectId);
  const derivatives = new Set(publications.filter(item => item.baseTopicId).flatMap(item => item.lessons.map(lesson => lesson.topicId)));
  return { subject, lessons: subject.topics.filter(topic => importedLessonHref(topic) && !derivatives.has(topic.id)), publications };
}
export async function audioLessonBook(familyId: string, request: AudioRequest): Promise<LibraryBook> {
  if (!request.lesson || request.materialId !== request.lesson.subjectId) throw new Error("Некоректне джерело аудіоуроку.");
  const source = await audioLessonOptions(familyId, request.lesson.subjectId);
  if (!source.lessons.some(topic => topic.id === request.lesson!.topicId)) throw new Error("Готовий урок не знайдено у цьому предметі.");
  return { id: request.lesson.subjectId, title: source.subject.name, author: "", format: "lesson", pages: null, chapters: [], settings: defaultLibrarySettings };
}
export async function readyAudioLessonSource(familyId: string, request: AudioRequest) {
  const book = await audioLessonBook(familyId, request); const lesson = request.lesson!;
  const { publications } = await audioLessonOptions(familyId, lesson.subjectId);
  const replacement = publications.find(project => project.mode === "revision" && project.baseTopicId === lesson.topicId)?.lessons[0];
  const source = await loadVideoLessonSource(familyId, lesson.subjectId, replacement?.topicId ?? lesson.topicId);
  const paragraphs = [{ id: 0, page: 1, text: `Предмет: ${source.subject}\nТема: ${source.title}` }, ...source.blocks.map((block, index) => ({ id: index + 1, page: 1, text: `${block.title}\n${block.text}` }))];
  if (!source.blocks.length || paragraphs.reduce((size, p) => size + p.text.length, 0) > 60000) throw new Error("Матеріал уроку завеликий для одного аудіоуроку або не містить тексту.");
  return { book, range: { from: 1, to: 1 }, paragraphs, notes: "Джерело — текст готового уроку. Це навчальний аудіоурок, а не дослівне читання книги." };
}
