/** Routing selectors only. Authorization stays in each existing reader. */
export interface ImportedLessonSelectors {
  literatureLessonId?: string | null;
  courseLessonId?: string | null;
  mathCourseV2LessonId?: string | null;
  literatureV2LessonId?: string | null;
  literatureV3LessonId?: string | null;
}
export function importedLessonHref(topic: ImportedLessonSelectors): string | null {
  const choices = [
    ["literature", topic.literatureLessonId], ["course-lesson", topic.courseLessonId],
    ["math-course-v2", topic.mathCourseV2LessonId], ["literature-course-v2", topic.literatureV2LessonId],
    ["literature-v3", topic.literatureV3LessonId],
  ] as const;
  const selected = choices.find(([, id]) => !!id);
  return selected ? `/${selected[0]}/${selected[1]}` : null;
}
