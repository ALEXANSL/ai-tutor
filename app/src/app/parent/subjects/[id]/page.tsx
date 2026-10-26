import Link from "next/link";
import { notFound } from "next/navigation";
import { ReadyLessonCatalog } from "@/components/parent/subjects/ReadyLessonCatalog";
import { RenameSubjectForm } from "@/components/parent/subjects/RenameSubjectForm";
import { TextbookLinkPanel } from "@/components/parent/subjects/TextbookLinkPanel";
import { VideoLessonsPanel } from "@/components/parent/subjects/VideoLessonsPanel";
import { importedLessonHref } from "@/lib/imported-lesson-link";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listVideoLessonsForSubject } from "@/server/lessons/videoLessons";
import { getSubjectDetail } from "@/server/subjects/queries";
import { listSubjectPackages, listSubjectPdfMaterials } from "@/server/subjects/contentAdmin";
import { PageTitle, Panel } from "../../ui";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Prepared ZIP courses are the catalog. Legacy generation/indexing is not
 * a prerequisite; existing PDF links remain optional source material. */
export default async function SubjectDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const access = await requireParentAccess();
  const { familyId } = access;
  const subject = await getSubjectDetail(familyId, id);
  if (!subject) notFound();
  const topics = subject.topics.filter(topic => importedLessonHref(topic));
  const [packages, pdfOptions, videos] = await Promise.all([
    listSubjectPackages(familyId, id), listSubjectPdfMaterials(familyId, id),
    listVideoLessonsForSubject(familyId, id).catch(() => null),
  ]);
  return <>
    <PageTitle><Link href="/parent/subjects" className="mb-1 block text-[13px] font-normal text-p-primary">{uk.parent.subjects.detail.back}</Link>{subject.name}</PageTitle>
    <div className="mb-4 flex flex-wrap gap-3"><Link href="/parent/materials" className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-sm font-bold text-white">Додати готовий курс ZIP</Link></div>
    <Panel title="Уроки предмета">
      {topics.length ? <ReadyLessonCatalog topics={topics} canOpen={access.via === "tablet"} /> : <p className="text-sm text-p-muted">Готових уроків поки немає. Підготуйте матеріали у ChatGPT за універсальним промптом і завантажте ZIP курсу в розділі «Завантажити матеріали».</p>}
    </Panel>
    <Panel title="Додаткові відеоматеріали">
      {videos ? <VideoLessonsPanel topics={topics.map(topic => ({ id: topic.id, title: topic.title }))} initialVideos={videos} /> : <p role="status" className="text-sm text-p-muted">Не вдалося завантажити відеосписок. Оновіть сторінку, щоб спробувати ще раз.</p>}
    </Panel>
    <details className="mt-4 rounded-2xl border border-p-line bg-p-surface p-4">
      <summary className="cursor-pointer text-sm font-bold text-p-muted">Налаштування предмета та джерел PDF</summary>
      <div className="mt-4 space-y-5"><RenameSubjectForm subjectId={subject.id} name={subject.name} />
        {packages.length > 0 && <div><h2 className="mb-2 text-sm font-bold">PDF-джерела наявних уроків</h2><TextbookLinkPanel packages={packages} pdfOptions={pdfOptions} /></div>}
      </div>
    </details>
  </>;
}
