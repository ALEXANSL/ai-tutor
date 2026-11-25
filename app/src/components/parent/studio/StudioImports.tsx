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
    course: <Panel title="Імпорт готового курсу (ZIP)"><p className="mb-4 text-sm text-p-muted">Для курсів, уже підготовлених поза застосунком. Нові уроки зручніше створювати в Майстерні: «Створити з ідеї або матеріалів».</p><UnifiedCourseImportPanel subjects={subjects} /></Panel>,
    video: <Panel title="Відео до уроку"><VideoLessonUploadPanel subjects={subjects} /><Link href="/parent/videos" className="mt-4 inline-flex min-h-11 items-center font-bold text-p-primary">Керувати завантаженими відео →</Link></Panel>,
    book: <><Panel title="Книга або підручник як джерело"><p className="text-sm text-p-muted">Додай книгу, презентацію, документ, фото або текст із пристрою. Після обробки одразу переходь до створення уроку; перевіряти папку Google Drive не потрібно.</p><div className="mt-4 flex flex-wrap gap-3"><Link href="/parent/books" className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 font-bold">Бібліотека джерел</Link><Link href="/parent/studio/presentations" className="inline-flex min-h-11 items-center px-4 font-bold text-p-primary">Показати PPTX як слайди з озвученням →</Link></div></Panel><StudioSourceUpload enabled={uploadEnabled} /></>,
    materials: <Panel title="Посібник або додатковий матеріал"><MaterialsImportPanel subjects={subjects} uploadEnabled={uploadEnabled} materialsOnly /></Panel>,
  }}</ContentWorkspace>;
}
