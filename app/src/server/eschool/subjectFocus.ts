import "server-only";
import type { SchoolEntry } from "@/lib/eschool";
import { schoolTopicFocus } from "@/lib/eschool-topic-focus";
import { readSchoolDoc, SCHOOL_ENTRY } from "./store";
export async function schoolSubjectFocus(familyId: string, childId: string, subjectId: string, entryId: string, topics: readonly { id: string; title: string }[]) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entryId)) return null;
  const entry = await readSchoolDoc<SchoolEntry>(familyId, childId, entryId, SCHOOL_ENTRY);
  if (!entry || entry.subjectId !== subjectId) return null;
  return { entryId, title: entry.source.topic, topicId: schoolTopicFocus(entry, topics) };
}
