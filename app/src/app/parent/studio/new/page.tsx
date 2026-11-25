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
import { voiceActor } from "@/server/voice/service";
import { readSchoolDoc, SCHOOL_ENTRY } from "@/server/eschool/store";
import { schoolStudioPrefill } from "@/lib/school-day";
import type { SchoolEntry } from "@/lib/eschool";
export const maxDuration = 300;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export default async function StudioNewPage({ searchParams }: {
  searchParams: Promise<{ subject?: string; topic?: string; material?: string; draft?: string; saved?: string; school?: string }>;
}) {
  const { familyId } = await requireParentAccess();
  const query = await searchParams;
  if (query.draft && !UUID.test(query.draft)) notFound();
  const draft = query.draft ? await readStudioFormDraft(familyId, query.draft) : null;
  if (query.draft && !draft) notFound();
  if (draft?.projectId) redirect(`/parent/studio/${draft.projectId}`);
  // A diary entry from the "Школа на завтра" tab prefills subject, title and goal; nothing is launched.
  const schoolEntry = !draft && UUID.test(query.school ?? "")
    ? await voiceActor(familyId).then(({ child }) => readSchoolDoc<SchoolEntry>(familyId, child.id, query.school!, SCHOOL_ENTRY)).catch(() => null) : null;
  const prefill = schoolEntry ? schoolStudioPrefill(schoolEntry.source) : null;
  const subjectId = draft ? draft.values.subjectId ?? "" : schoolEntry ? schoolEntry.subjectId ?? "" : (UUID.test(query.subject ?? "") ? query.subject! : "");
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
      <PageTitle>{draft ? "Продовжити чернетку" : prefill ? (schoolEntry!.source.kind === "homework" ? "Допомога з домашнім завданням" : "Урок до шкільної теми") : topic ? "Розширити урок" : "Новий урок або курс"}</PageTitle>
      {prefill && <p className="mb-4 text-sm text-p-muted">Поля заповнено зі щоденника. Додай фото сторінки підручника чи зошита в «Матеріали для уроку», якщо є, і запусти підготовку.</p>}
      {books === null && <p role="status" className="mb-4 text-sm text-p-muted">Бібліотека книг зараз недоступна. Можна працювати з ідеєю, власним текстом або базовим уроком.</p>}
      <StudioCreate storageKey={storageKey} initialDraft={draft} initialSaved={query.saved === "1"}
        uploadEnabled={uploadEnabled} initialMaterial={initialMaterial} subjects={subjects} books={choices}
        initialSubject={subject?.id} initialTopic={prefill ? undefined : topic?.id} initialTitle={prefill?.title ?? topic?.title}
        initialIdea={prefill?.idea} contextId={schoolEntry ? `school:${query.school}` : undefined}
        initialGrade={year.data?.grade} />
    </div>
  );
}
