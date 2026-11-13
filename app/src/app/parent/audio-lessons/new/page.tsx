import { requireParentAccess } from "@/server/auth/guards";
import { forFamily } from "@/server/db/family-scope";
import { AudioLessonCreate } from "@/components/library/AudioLessonCreate";
import { z } from "zod";
import { audioLessonOptions } from "@/server/audiobooks/lesson-source";
export const maxDuration = 300;
export default async function Page({ searchParams }: { searchParams: Promise<{ subject?: string; topic?: string }> }) {
  const { familyId } = await requireParentAccess(); const query = await searchParams;
  const { data, error } = await forFamily(familyId).select("subjects", "id,name:name_uk").order("sort_order").returns<{ id: string; name: string }[]>();
  if (error) throw new Error("Не вдалося прочитати предмети.");
  const subjectId = z.string().uuid().safeParse(query.subject).success && data?.some(subject => subject.id === query.subject) ? query.subject! : "";
  const source = subjectId ? await audioLessonOptions(familyId, subjectId) : null;
  return <div className="mx-auto max-w-3xl"><AudioLessonCreate subjects={data ?? []} subjectId={subjectId} topicId={query.topic ?? ""} lessons={source?.lessons.map(topic => ({ id: topic.id, title: topic.title })) ?? []} /></div>;
}
