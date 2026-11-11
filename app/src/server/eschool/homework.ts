import "server-only";
import { forFamily } from "@/server/db/family-scope";
import type { SchoolEntry } from "@/lib/eschool";
import type { VoiceTarget } from "@/lib/voice";
import { homeworkHref } from "@/lib/homework";
import { getLiteratureV3LessonView } from "@/server/lessons/literatureV3View";
import { readSchoolDoc, SCHOOL_ENTRY } from "./store";
import { updateSchoolEntry } from "./service";
export async function schoolAssignment(familyId: string, childId: string, id: string, subjectId?: string) {
  const entry = await readSchoolDoc<SchoolEntry>(familyId, childId, id, SCHOOL_ENTRY);
  if (!entry || entry.source.kind !== "homework" || (subjectId && entry.subjectId !== subjectId)) throw new Error("Завдання не належить цьому предмету або недоступне.");
  return entry;
}
export function schoolAssignmentPrompt(entry: SchoolEntry) {
  const source = entry.source;
  return `Допоможи виконати домашнє завдання з предмета «${source.subject}».\n${source.topic ? `Тема: ${source.topic}\n` : ""}Завдання вчителя:\n${source.text}\n\n${source.dueDate ? `Потрібно на ${source.dueDate}.\n` : ""}Поясни відповідь зрозуміло й підготуй результат за умовою завдання.`;
}
export async function schoolHomeworkLaunch(familyId: string, childId: string, id: string): Promise<string | null> {
  const entry = await schoolAssignment(familyId, childId, id);
  if (!entry.source.text || !entry.lessonHref) return null;
  const match = /^\/(literature-v3|math-course-v2|literature-course-v2)\/([a-f0-9-]{36})$/i.exec(entry.lessonHref);
  if (!match) return null;
  let target: VoiceTarget;
  if (match[1] === "literature-v3") {
    const lesson = await getLiteratureV3LessonView(familyId, match[2]!, { includeIllustrations: false });
    const first = lesson?.flow[0]; if (!lesson || !first || lesson.subjectId !== entry.subjectId) return null;
    target = { kind: "chapter", lessonId: match[2]!, stepId: first.id };
  } else {
    const table = match[1] === "math-course-v2" ? "course_v2_screens" : "literature_v2_screens";
    const result = await forFamily(familyId).select(table, "id").eq("lesson_id", match[2]!).order("order_no").limit(1).maybeSingle<{ id: string }>();
    if (result.error || !result.data) return null;
    target = { kind: "course", refTable: table, refId: result.data.id };
  }
  return `${homeworkHref(target)}&assignment=${id}`;
}
export async function attachSchoolWork(familyId: string, childId: string, assignmentId: string, workId: string, target: VoiceTarget) {
  const entry = await schoolAssignment(familyId, childId, assignmentId);
  await updateSchoolEntry(familyId, childId, assignmentId, entry.revision, { workHref: `${homeworkHref(target)}&work=${workId}&assignment=${assignmentId}`, ...(entry.status === "todo" ? { status: "working" as const } : {}) });
}
