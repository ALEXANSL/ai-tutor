import { normalizedSchoolSubject, type SchoolEntry } from "./eschool";
type Subject = { id: string; name: string };
function subjectKey(value: string): string {
  const name = normalizedSchoolSubject(value);
  if (/істор/.test(name)) {
    const ukraine = /україн/.test(name), world = /всесвіт/.test(name);
    return ukraine === world ? "history:all" : ukraine ? "history:ua" : "history:world";
  }
  if (/англ/.test(name)) return "english";
  if (/німець|(?:^| )нім(?: |$)/u.test(name)) return "german";
  if (/зарубіж|світов.*літератур/.test(name)) return "foreign-literature";
  if (/україн.*літератур/.test(name)) return "ukrainian-literature";
  if (/україн.*мов/.test(name)) return "ukrainian-language";
  if (/пізнаємо природу|пізнання природи|природознав/.test(name)) return "nature";
  return name;
}
export function schoolSubjectCandidates(name: string, subjects: readonly Subject[]): Subject[] {
  const exact = subjects.filter(subject => normalizedSchoolSubject(subject.name) === normalizedSchoolSubject(name));
  if (exact.length) return exact;
  const key = subjectKey(name);
  return subjects.filter(subject => {
    const candidate = subjectKey(subject.name);
    return candidate === key || (key.startsWith("history:") && candidate.startsWith("history:") && (key === "history:all" || candidate === "history:all"));
  });
}
export function schoolEntrySubjects(entry: SchoolEntry, subjects: readonly Subject[]): Subject[] {
  return entry.subjectId ? subjects.filter(subject => subject.id === entry.subjectId) : schoolSubjectCandidates(entry.source.subject, subjects);
}
