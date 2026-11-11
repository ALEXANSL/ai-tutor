import Link from "next/link";
import { requireLessonAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { homeworkSource } from "@/server/homework/source";
import { listHomework, readHomework } from "@/server/homework/store";
import { schoolAssignment, schoolAssignmentPrompt } from "@/server/eschool/homework";
import { homeworkView } from "@/lib/homework";
import { HomeworkWorkspace } from "@/components/homework/HomeworkWorkspace";
import { unstable_rethrow } from "next/navigation";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ target?: string; work?: string; assignment?: string }> }) {
  const { familyId } = await requireLessonAccess();
  let props: Parameters<typeof HomeworkWorkspace>[0] | null = null;
  try {
    const params = await searchParams; const actor = await voiceActor(familyId);
    const source = await homeworkSource(familyId, actor.child.id, JSON.parse(params.target ?? "null"));
    const rows = await listHomework(familyId, actor.child.id, source.lessonKey);
    // A direct older work link remains available even if it is outside the recent list.
    if (params.work && /^[a-f0-9-]{36}$/i.test(params.work) && !rows.some(row => row.id === params.work)) {
      const found = await readHomework(familyId, actor.child.id, params.work); if (found?.lessonKey === source.lessonKey) rows.unshift({ id: params.work, payload: found });
    }
    const assignment = params.assignment && /^[a-f0-9-]{36}$/i.test(params.assignment) ? await schoolAssignment(familyId, actor.child.id, params.assignment, source.resolved.subjectId) : null;
    props = { ...(assignment ? { assignmentId: params.assignment, initialQuestion: params.work ? "" : schoolAssignmentPrompt(assignment) } : {}), target: source.target, lessonTitle: source.lessonTitle, backHref: source.backHref, pages: source.pages, initial: rows.map(row => homeworkView(row.id, row.payload)), initialId: params.work };
  } catch (error) { unstable_rethrow(error); }
  if (props) return <HomeworkWorkspace {...props} />;
  return <main className="mx-auto max-w-xl space-y-4 px-4 pt-24"><h1 className="text-2xl font-extrabold">Відкрий завдання з уроку</h1><p>Повернися до потрібного уроку й натисни «Домашнє завдання». Так репетитор отримає правильну тему й матеріали.</p><Link href="/today" className="inline-flex min-h-12 items-center rounded-full border border-line px-4 font-bold">На головну</Link></main>;
}
