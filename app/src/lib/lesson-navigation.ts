export function nextActiveLessonHref(basePath: string, currentId: string, lessons: { id: string; status: string }[]): string | null {
  const active = lessons.filter(lesson => lesson.status === "active");
  const index = active.findIndex(lesson => lesson.id === currentId);
  const next = index >= 0 ? active[index + 1] : null;
  return next ? `${basePath}/${encodeURIComponent(next.id)}` : null;
}
