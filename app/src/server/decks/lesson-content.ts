import "server-only";
import { getCourseLessonView } from "@/server/lessons/courseView";
import { getLiteratureLessonView } from "@/server/lessons/literatureView";
import { getLiteratureV2LessonView } from "@/server/lessons/literatureV2View";
import { getLiteratureV3LessonView } from "@/server/lessons/literatureV3View";
import { getMathCourseV2LessonView } from "@/server/lessons/mathCourseV2View";

// href is resolved by deckLessonOptions for the authenticated family.
export async function lessonSlideSource(family: string, href: string) {
  const [, kind, id] = href.split("/");
  if (!id) throw new Error("Урок недоступний.");
  let parts: string[] = [];
  if (kind === "literature-v3") {
    const lesson = await getLiteratureV3LessonView(family, id, { includeIllustrations: false });
    parts = lesson?.flow.map(s => s.kind === "quiz" ? s.question.displayMd : s.displayText) ?? [];
  } else if (kind === "math-course-v2") {
    const lesson = await getMathCourseV2LessonView(family, id);
    if (lesson) parts = [...lesson.objectives, ...lesson.screens.map(s => s.displayMd)];
  } else if (kind === "literature-course-v2") {
    const lesson = await getLiteratureV2LessonView(family, id);
    if (lesson) parts = [...lesson.objectives, ...lesson.explanation.map(s => s.display), ...lesson.screens.map(s => s.content.display)];
  } else if (kind === "literature") {
    const lesson = await getLiteratureLessonView(family, id);
    if (lesson) parts = [lesson.goalUk, lesson.explanationMd, lesson.work?.summaryUk ?? "", lesson.work?.excerptsUk ?? ""];
  } else if (kind === "course-lesson") {
    const lesson = await getCourseLessonView(family, id);
    if (lesson) parts = [lesson.teacherNotesMd, ...lesson.automaticQuestions.map(q => q.promptMd + "\n" + q.explanationMd), ...lesson.sourceImages.map(i => i.searchTextOcr ?? "")];
  }
  const text = parts.filter(Boolean).join("\n\n").trim();
  if (!text) throw new Error("У цьому уроці немає доступного навчального тексту для презентації.");
  return text;
}
