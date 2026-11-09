import "server-only";
import { createHash } from "node:crypto";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { getLiteratureV3LessonView } from "@/server/lessons/literatureV3View";
import { getMathCourseV2LessonView } from "@/server/lessons/mathCourseV2View";
import { getLiteratureV2LessonView } from "@/server/lessons/literatureV2View";
import { getLiteratureLessonView } from "@/server/lessons/literatureView";
import { getCourseLessonView } from "@/server/lessons/courseView";

export interface VideoSourceBlock { id: string; title: string; text: string; }
export interface VideoLessonSource { title: string; subject: string; hash: string; blocks: VideoSourceBlock[]; }
export class VideoSourceError extends Error {}
function lessonText(display: string, narration?: string): string {
  if (!narration?.trim() || display.trim() === narration.trim()) return display;
  if (!display.trim()) return narration;
  return `Текст на екрані:\n${display}\n\nТекст озвучення:\n${narration}`;
}

export async function loadVideoLessonSource(familyId: string, subjectId: string, topicId: string): Promise<VideoLessonSource> {
  const subject = await getSubjectDetail(familyId, subjectId);
  const topic = subject?.topics.find(item => item.id === topicId);
  const href = topic && importedLessonHref(topic);
  if (!subject || !topic || !href) throw new VideoSourceError("Готовий урок не знайдено у цьому предметі.");
  const [, kind, lessonId] = href.split("/");
  if (!lessonId) throw new VideoSourceError("Не вдалося визначити урок.");
  const blocks: VideoSourceBlock[] = [];
  let mainTextLength = 0;
  const add = (title: string, text: string, main = true) => {
    if (!text.trim()) return;
    blocks.push({ id: `b${blocks.length + 1}`, title, text });
    if (main) mainTextLength += text.trim().length;
  };
  const checked = <T extends { subjectId: string; topicId?: string | null; status: string }>(lesson: T | null): T => {
    if (!lesson || lesson.subjectId !== subjectId || lesson.topicId !== topicId || lesson.status !== "active") throw new VideoSourceError("Урок недоступний або потребує перевірки.");
    return lesson;
  };
  if (kind === "literature-v3") {
    const lesson = checked(await getLiteratureV3LessonView(familyId, lessonId, { includeIllustrations: false }));
    for (const step of lesson.flow) {
      if (step.kind === "quiz") add("Запитання для самоперевірки", lessonText(step.question.displayMd, step.question.narration), false);
      else add(step.kind === "reading" ? `${step.workTitle}. ${step.workAuthor}. ${step.title}` : step.kind === "biography" ? step.authorName : step.title, lessonText(step.displayText, step.ttsText));
    }
  } else if (kind === "math-course-v2") {
    const lesson = checked(await getMathCourseV2LessonView(familyId, lessonId));
    for (const step of lesson.screens) add(step.title, lessonText(step.displayMd, step.narration));
    for (const task of lesson.exercises) add(`Вправа ${task.originalNumber}`, lessonText(task.displayMd, task.narration), false);
  } else if (kind === "literature-course-v2") {
    const lesson = checked(await getLiteratureV2LessonView(familyId, lessonId));
    for (const text of lesson.explanation) add("Пояснення", lessonText(text.display, text.tts?.text));
    for (const def of lesson.definitions) add(def.term, lessonText(def.explanation.display, def.explanation.tts?.text));
    for (const step of lesson.screens) add(step.stepType, lessonText(step.content.display, step.content.tts?.text));
    for (const step of lesson.workedExample?.steps ?? []) add("Приклад", lessonText(step.display, step.tts?.text));
    for (const task of lesson.tasks) add(task.originalLabel, [lessonText(task.prompt.display, task.prompt.tts?.text), ...task.subtasks.map(part => lessonText(part.display, part.tts?.text))].join("\n"), false);
  } else if (kind === "literature") {
    const lesson = checked(await getLiteratureLessonView(familyId, lessonId));
    add("Пояснення", lesson.explanationMd);
    if (lesson.work) {
      add("Автор", lesson.work.authorBioUk ?? "");
      add(lesson.work.titleUk, lesson.work.excerptsUk);
      add("Стислий виклад", lesson.work.summaryUk);
      add("Герої та ідея", [lesson.work.charactersUk, lesson.work.ideaUk].filter(Boolean).join("\n"));
    }
  } else if (kind === "course-lesson") {
    const lesson = checked(await getCourseLessonView(familyId, lessonId));
    // This legacy format may have only images. Never invent a lesson from its title.
    for (const image of lesson.sourceImages) add(`Сторінка ${image.printedPage ?? ""}`, image.searchTextOcr ?? "");
  } else throw new VideoSourceError("Цей формат уроку не підтримується.");
  if (mainTextLength < 200) throw new VideoSourceError("У цьому уроці недостатньо основного тексту для сценарію. Додайте пояснення або уривки твору: самих запитань чи зображень недостатньо.");
  const raw = JSON.stringify({ subject: subject.name, title: topic.title, blocks });
  if (raw.length > 60_000) throw new VideoSourceError("Текст уроку перевищує 60 000 символів. Підготуйте коротший урок або розділіть його на частини; текст не обрізався.");
  return { subject: subject.name, title: topic.title, blocks, hash: createHash("sha256").update(raw).digest("hex") };
}
