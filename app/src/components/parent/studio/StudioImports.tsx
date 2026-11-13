import { AddBookPanel } from "@/components/parent/books/AddBookPanel";
import Link from "next/link";
import { ContentWorkspace, type ContentSection } from "@/components/parent/materials/ContentWorkspace";
import { UnifiedCourseImportPanel } from "@/components/parent/materials/UnifiedCourseImportPanel";
import { MaterialsImportPanel } from "@/components/parent/materials/MaterialsImportPanel";
import { VideoLessonUploadPanel } from "@/components/parent/materials/VideoLessonUploadPanel";
import { listSubjects } from "@/server/books/queries";
import { isUploadsFolderConfigured, isDriveConfigured } from "@/server/drive/service";
import { Panel } from "@/app/parent/ui";
export async function StudioImports({ familyId, tab }: { familyId: string; tab: ContentSection }) {
  const [subjects, uploadEnabled, driveConfigured] = await Promise.all([listSubjects(familyId), isUploadsFolderConfigured(familyId), isDriveConfigured(familyId)]);
  return <ContentWorkspace key={tab} initialSection={tab}>{{
    course: <Panel title="Готовий курс — один ZIP"><p className="mb-4 text-sm text-p-muted">Один архів із матеріалами. Нижче є універсальний промпт для підготовки повного пакета; ілюстрації та PDF уроків необов’язкові.</p><UnifiedCourseImportPanel subjects={subjects} /></Panel>,
    video: <Panel title="Відео до уроку"><VideoLessonUploadPanel subjects={subjects} /><Link href="/parent/videos" className="mt-4 inline-flex min-h-11 items-center font-bold text-p-primary">Керувати завантаженими відео →</Link></Panel>,
    book: <><Panel title="Книга або підручник як джерело"><p className="text-sm text-p-muted">Додай PDF / EPUB до бібліотеки. Потім вибирай книгу й сторінки у формі створення уроку. Саме завантаження книги не створює уроків.</p><div className="mt-4 flex flex-wrap gap-3"><Link href="/parent/books" className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 font-bold">Бібліотека джерел</Link></div></Panel><AddBookPanel driveConfigured={driveConfigured} uploadEnabled={uploadEnabled} /></>,
    materials: <Panel title="Посібник або додатковий матеріал"><MaterialsImportPanel subjects={subjects} uploadEnabled={uploadEnabled} materialsOnly /></Panel>,
  }}</ContentWorkspace>;
}
