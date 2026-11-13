import "server-only";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { getSubjectDetail } from "@/server/subjects/queries";
import { getLiteratureV3LessonView } from "@/server/lessons/literatureV3View";
import { getLiteratureLessonView } from "@/server/lessons/literatureView";
import { getLiteratureV2LessonView } from "@/server/lessons/literatureV2View";
/** Strip display markup only; preserve every supplied word, stanza, dialogue and repeated refrain. */
export function readingPlainText(text: string) {
  return text.replace(/^#{1,6}\s+/gm, "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\r\n?/g, "\n").trim();
}
export async function lessonReadingSource(familyId: string, subjectId: string, topicId: string) {
  const subject = await getSubjectDetail(familyId, subjectId); const topic = subject?.topics.find(item => item.id === topicId);
  const href = topic && importedLessonHref(topic); if (!subject || !topic || !href) throw new Error("Урок читання не знайдено.");
  const [, kind, id] = href.split("/"); const texts: { title: string; author: string; text: string }[] = [];
  const owned = (lesson: { subjectId: string; topicId?: string | null; status: string } | null) => lesson?.subjectId === subjectId && lesson.topicId === topicId && lesson.status === "active";
  if (kind === "literature-v3") {
    const lesson = await getLiteratureV3LessonView(familyId, id!, { includeIllustrations: false });
    if (!owned(lesson)) throw new Error("Урок читання недоступний.");
    for (const step of lesson!.flow) if (step.kind === "reading") texts.push({ title: step.workTitle || step.title, author: step.workAuthor, text: step.displayText });
  } else if (kind === "literature") {
    const lesson = await getLiteratureLessonView(familyId, id!); if (!owned(lesson)) throw new Error("Урок читання недоступний.");
    if (lesson!.work?.excerptsUk) texts.push({ title: lesson!.work.titleUk, author: "", text: lesson!.work.excerptsUk });
  } else if (kind === "literature-course-v2") {
    const lesson = await getLiteratureV2LessonView(familyId, id!); if (!owned(lesson)) throw new Error("Урок читання недоступний.");
    for (const step of lesson!.screens) if (step.stepType === "reading") texts.push({ title: "", author: "", text: step.content.display });
  }
  if (!texts.length || !texts.some(item => readingPlainText(item.text))) throw new Error("У цьому уроці немає окремого тексту твору для дослівного читання. Обери книгу/сторінки або додай текст читання до уроку; переказ не замінює оригінал.");
  const headings = new Set<string>(); const paragraphs: { id: number; page: number; text: string }[] = [];
  for (const item of texts) {
    const heading = [item.author, item.title].filter(Boolean).join(". ");
    if (heading && !headings.has(heading)) { paragraphs.push({ id: paragraphs.length, page: 1, text: heading }); headings.add(heading); }
    paragraphs.push({ id: paragraphs.length, page: 1, text: readingPlainText(item.text) });
  }
  if (paragraphs.reduce((size, item) => size + item.text.length, 0) > 60000) throw new Error("Наданий текст завеликий для однієї аудіочастини. Обери коротший розділ/урок; текст не скорочувався.");
  return paragraphs;
}
