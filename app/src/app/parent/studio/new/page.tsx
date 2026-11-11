import Link from "next/link";
import { requireParentAccess } from "@/server/auth/guards";
import { listBooks, listSubjects } from "@/server/books/queries";
import { getSubjectDetail } from "@/server/subjects/queries";
import { forFamily } from "@/server/db/family-scope";
import { StudioCreate } from "@/components/parent/studio/StudioCreate";
import { PageTitle } from "../../ui";
export const maxDuration = 300;
export default async function StudioNewPage({ searchParams }: { searchParams: Promise<{ subject?: string; topic?: string }> }) {
  const { familyId } = await requireParentAccess(); const query = await searchParams;
  const subjectId = /^[a-f0-9-]{36}$/i.test(query.subject ?? "") ? query.subject! : "";
  const [subjects, books, subject, year] = await Promise.all([listSubjects(familyId), listBooks(familyId).catch(() => null), subjectId ? getSubjectDetail(familyId, subjectId) : null, forFamily(familyId).select("academic_years", "grade").eq("status", "active").limit(1).maybeSingle<{ grade: number }>()]);
  const topic = subject?.topics.find(item => item.id === query.topic);
  return <div className="mx-auto max-w-4xl"><Link href="/parent/studio" className="mb-3 inline-flex min-h-11 items-center text-sm font-bold text-p-primary">← Майстерня ШІ</Link><PageTitle>{topic ? "Розширити урок" : "Новий урок або курс"}</PageTitle>{books === null && <p role="status" className="mb-4 text-sm text-p-muted">Бібліотека книг зараз недоступна. Можна працювати з ідеєю, власним текстом або базовим уроком.</p>}<StudioCreate subjects={subjects} books={(books ?? []).map(book => ({ id: book.id, title: book.title || book.name }))} initialSubject={subject?.id} initialTopic={topic?.id} initialTitle={topic?.title} initialGrade={year.data?.grade} /></div>;
}
