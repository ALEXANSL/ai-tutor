import { StudioSourceUpload } from "./StudioSourceUpload";
import Link from "next/link";
import { ContentWorkspace, type ContentSection } from "@/components/parent/materials/ContentWorkspace";
import { UnifiedCourseImportPanel } from "@/components/parent/materials/UnifiedCourseImportPanel";
import { MaterialsImportPanel } from "@/components/parent/materials/MaterialsImportPanel";
import { VideoLessonUploadPanel } from "@/components/parent/materials/VideoLessonUploadPanel";
import { listSubjects } from "@/server/books/queries";
import { isUploadsFolderConfigured } from "@/server/drive/service";
import { Panel } from "@/app/parent/ui";
export async function StudioImports({ familyId, tab }: { familyId: string; tab: ContentSection }) {
  const [subjects, uploadEnabled] = await Promise.all([listSubjects(familyId), isUploadsFolderConfigured(familyId)]);
  return <ContentWorkspace key={tab} initialSection={tab}>{{
    course: <Panel title="Готовий курс — один ZIP"><p className="mb-4 text-sm text-p-muted">Один архів із матеріалами. Нижче є універсальний промпт для підготовки повного пакета; ілюстрації та PDF уроків необов’язкові.</p><UnifiedCourseImportPanel subjects={subjects} /></Panel>,
    video: <Panel title="Відео до уроку"><VideoLessonUploadPanel subjects={subjects} /><Link href="/parent/videos" className="mt-4 inline-flex min-h-11 items-center font-bold text-p-primary">Керувати завантаженими відео →</Link></Panel>,
    book: <><Panel title="Книга або підручник як джерело"><p className="text-sm text-p-muted">Додай книгу, презентацію, документ, фото або текст із пристрою. Після обробки одразу переходь до створення уроку; перевіряти папку Google Drive не потрібно.</p><div className="mt-4 flex flex-wrap gap-3"><Link href="/parent/books" className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 font-bold">Бібліотека джерел</Link></div></Panel><StudioSourceUpload enabled={uploadEnabled} /></>,
    materials: <Panel title="Посібник або додатковий матеріал"><MaterialsImportPanel subjects={subjects} uploadEnabled={uploadEnabled} materialsOnly /></Panel>,
  }}</ContentWorkspace>;
}
