import "server-only";
import { lessonVoiceTargetSchema, resolveLessonVoiceTarget } from "@/server/voice/lessonContext";
import { getLiteratureV3BookIndex, getLiteratureV3LessonView } from "@/server/lessons/literatureV3View";
import { forFamily } from "@/server/db/family-scope";
import type { VoiceTarget } from "@/lib/voice";
export async function homeworkSource(familyId: string, childId: string, raw: unknown) {
  const target = lessonVoiceTargetSchema.parse(raw);
  if (target.kind === "friend") throw new Error("Відкрий домашнє завдання з потрібного уроку.");
  const resolved = await resolveLessonVoiceTarget(familyId, childId, target);
  if (!resolved.subjectId || !resolved.topicId || !resolved.lessonRef) throw new Error("Цей урок недоступний.");
  const scope = forFamily(familyId);
  const [subject, topic] = await Promise.all([
    scope.select("subjects", "name:name_uk").eq("id", resolved.subjectId).maybeSingle<{ name: string }>(),
    scope.select("topics", "title").eq("id", resolved.topicId).eq("subject_id", resolved.subjectId).maybeSingle<{ title: string }>(),
  ]);
  if (subject.error || topic.error || !subject.data || !topic.data) throw new Error("Предмет або тема недоступні.");
  let context = resolved.context;
  let pages: number[] = [];
  let lessonTitle = topic.data.title;
  if (target.kind === "chapter") {
    const lesson = await getLiteratureV3LessonView(familyId, target.lessonId, { includeIllustrations: false });
    if (!lesson) throw new Error("Урок недоступний.");
    lessonTitle = lesson.title;
    const parts = lesson.flow.map(step => step.kind === "quiz" ? step.question.displayMd : step.displayText);
    const full = parts.join("\n\n");
    context += `\nМАТЕРІАЛИ УРОКУ:\n${full.slice(0, 40000)}${full.length > 40000 ? "\nМатеріал скорочено; потрібну сторінку додай окремо." : ""}`;
    if (lesson.packageId) pages = (await getLiteratureV3BookIndex(familyId, lesson.packageId)).map(page => page.printedPage);
  } else if (target.kind === "course") {
    const math = target.refTable.startsWith("course_v2_");
    const [screens, tasks] = await Promise.all([
      scope.select(math ? "course_v2_screens" : "literature_v2_screens", math ? "display_md" : "content_display").eq("lesson_id", resolved.lessonRef.lessonId).order("order_no").limit(50).returns<{ display_md?: string; content_display?: string }[]>(),
      scope.select(math ? "course_v2_exercises" : "literature_v2_tasks", math ? "original_number,display_md" : "original_label,prompt_display").eq("lesson_id", resolved.lessonRef.lessonId).limit(100).returns<{ original_number?: string; original_label?: string; display_md?: string; prompt_display?: string }[]>(),
    ]);
    if (screens.error || tasks.error) throw new Error("Не вдалося отримати матеріали уроку.");
    const full = [...(screens.data ?? []).map(row => row.display_md ?? row.content_display ?? ""), ...(tasks.data ?? []).map(row => `${row.original_number ?? row.original_label ?? ""}: ${row.display_md ?? row.prompt_display ?? ""}`)].join("\n\n");
    context += `\nМАТЕРІАЛИ УРОКУ:\n${full.slice(0, 40000)}${full.length > 40000 ? "\nМатеріал скорочено." : ""}`;
  }
  const ref = resolved.lessonRef;
  const backHref = ref.kind === "chapter" ? `/literature-v3/${ref.lessonId}` : ref.kind === "session" ? `/lesson/${ref.lessonId}` : ref.kind === "math" ? `/math-course-v2/${ref.lessonId}` : `/literature-course-v2/${ref.lessonId}`;
  return { target: target as VoiceTarget, resolved, lessonKey: `${ref.kind}:${ref.lessonId}`, lessonTitle, backHref, subject: subject.data.name, topic: topic.data.title, context, pages: [...new Set(pages)].sort((a, b) => a - b) };
}
