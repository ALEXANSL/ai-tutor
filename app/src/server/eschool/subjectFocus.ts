import "server-only";
import { schoolEntrySubjects } from "@/lib/eschool-subject-match";
import { schoolSubjects } from "./service";
import type { SchoolEntry } from "@/lib/eschool";
import { schoolTopicMatches } from "@/lib/eschool-topic-focus";
import { contextMatchId, readContextMatch } from "./contextStore";
import { readSchoolDoc, SCHOOL_ENTRY } from "./store";
export async function schoolSubjectFocus(familyId: string, childId: string, subjectId: string, entryId: string, topics: readonly { id: string; title: string; pageFrom?: number | null; pageTo?: number | null }[]) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(entryId)) return null;
  const entry = await readSchoolDoc<SchoolEntry>(familyId, childId, entryId, SCHOOL_ENTRY);
  if (!entry) return null;
  if (entry.subjectId ? entry.subjectId !== subjectId : !schoolEntrySubjects(entry, await schoolSubjects(familyId, true)).some(subject => subject.id === subjectId)) return null;
  const known = schoolTopicMatches(entry, topics);
  const direct = known.length === 1 ? known[0]! : null;
  const cached = !known.length && !entry.topicId && topics.length ? await readContextMatch(familyId, childId, contextMatchId(familyId, childId, subjectId, entry, topics)).catch(() => null) : null;
  return { entryId, title: entry.source.topic, topicId: direct ?? (cached?.state === "done" && topics.some(topic => topic.id === cached.topicId) ? cached.topicId : null), topicIds: known.length ? known : (cached?.matches ?? []).filter(match => topics.some(topic => topic.id === match.topicId)).map(match => match.topicId), context: cached ? { state: cached.state, reason: cached.reason } : null };

}
