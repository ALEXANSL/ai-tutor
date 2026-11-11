import "server-only";
import { forFamily } from "@/server/db/family-scope";
export async function studioSubjectVisible(familyId: string, subjectId: string): Promise<boolean> {
  const scope = forFamily(familyId);
  const { data: subject, error } = await scope.select("subjects", "active,kind,group_id,is_stub").eq("id", subjectId).maybeSingle<{ active: boolean; kind: string; group_id: string | null; is_stub: boolean }>();
  if (error || !subject || !subject.active || subject.is_stub) return false;
  if (subject.kind === "course" && subject.group_id) {
    const group = await scope.select("course_groups", "active").eq("id", subject.group_id).maybeSingle<{ active: boolean }>();
    return !group.error && !!group.data?.active;
  }
  return true;
}
