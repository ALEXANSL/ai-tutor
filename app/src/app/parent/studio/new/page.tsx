import Link from "next/link";
import { createHash } from "node:crypto";
import { notFound, redirect } from "next/navigation";
import { isUploadsFolderConfigured } from "@/server/drive/service";
import { requireParentAccess } from "@/server/auth/guards";
import { listBooks, listSubjects } from "@/server/books/queries";
import { getSubjectDetail } from "@/server/subjects/queries";
import { forFamily } from "@/server/db/family-scope";
import { readStudioFormDraft } from "@/server/studio/drafts";
import { StudioCreate } from "@/components/parent/studio/StudioCreate";
import { PageTitle } from "../../ui";
export const maxDuration = 300;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export default async function StudioNewPage({ searchParams }: {
  searchParams: Promise<{ subject?: string; topic?: string; material?: string; draft?: string; saved?: string }>;
}) {
  const { familyId } = await requireParentAccess();
  const query = await searchParams;
  if (query.draft && !UUID.test(query.draft)) notFound();
  const draft = query.draft ? await readStudioFormDraft(familyId, query.draft) : null;
  if (query.draft && !draft) notFound();
  if (draft?.projectId) redirect(`/parent/studio/${draft.projectId}`);
  const subjectId = draft ? draft.values.subjectId ?? "" : (UUID.test(query.subject ?? "") ? query.subject! : "");
  const [subjects, books, subject, year, uploadEnabled] = await Promise.all([
    listSubjects(familyId), listBooks(familyId).catch(() => null),
    subjectId ? getSubjectDetail(familyId, subjectId) : null,
    forFamily(familyId).select("academic_years", "grade").eq("status", "active").limit(1).maybeSingle<{ grade: number }>(),
    isUploadsFolderConfigured(familyId),
  ]);
  const selectedTopic = draft ? draft.values.topicId : query.topic;
  const topic = subject?.topics.find(item => item.id === selectedTopic);
  const choices = (books ?? []).map(book => ({ id: book.id, title: book.title || book.name }));
  const selectedMaterial = draft ? draft.values.materialId ?? "" : (UUID.test(query.material ?? "") ? query.material! : "");
  // Uploaded sources can be temporarily absent from a library list; keep the
  // family-owned reference and label rather than silently dropping the choice.
  if (selectedMaterial && !choices.some(book => book.id === selectedMaterial)) {
    const { data } = await forFamily(familyId).select("materials", "id,title,name").eq("id", selectedMaterial)
      .maybeSingle<{ id: string; title: string | null; name: string }>();
    if (data) choices.push({ id: data.id, title: data.title || data.name });
  }
  const initialMaterial = choices.some(book => book.id === selectedMaterial) ? selectedMaterial : "";
  const storageKey = `studio-form:${createHash("sha256").update(familyId).digest("hex").slice(0, 32)}`;
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/parent/studio" className="mb-3 inline-flex min-h-11 items-center text-sm font-bold text-p-primary">← Майстерня ШІ</Link>
      <PageTitle>{draft ? "Продовжити чернетку" : topic ? "Розширити урок" : "Новий урок або курс"}</PageTitle>
      {books === null && <p role="status" className="mb-4 text-sm text-p-muted">Бібліотека книг зараз недоступна. Можна працювати з ідеєю, власним текстом або базовим уроком.</p>}
      <StudioCreate storageKey={storageKey} initialDraft={draft} initialSaved={query.saved === "1"}
        uploadEnabled={uploadEnabled} initialMaterial={initialMaterial} subjects={subjects} books={choices}
        initialSubject={subject?.id} initialTopic={topic?.id} initialTitle={topic?.title}
        initialGrade={year.data?.grade} />
    </div>
  );
}
