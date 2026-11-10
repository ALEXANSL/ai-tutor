import Link from "next/link";
import { ContentWorkspace } from "@/components/parent/materials/ContentWorkspace";
import { UnifiedCourseImportPanel } from "@/components/parent/materials/UnifiedCourseImportPanel";
import { MaterialsImportPanel } from "@/components/parent/materials/MaterialsImportPanel";
import { MathCourseV2ImportPanel } from "@/components/parent/materials/MathCourseV2ImportPanel";
import { LiteratureV2ImportPanel } from "@/components/parent/materials/LiteratureV2ImportPanel";
import { LiteratureV3ImportPanel } from "@/components/parent/materials/LiteratureV3ImportPanel";
import { VideoLessonUploadPanel } from "@/components/parent/materials/VideoLessonUploadPanel";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listSubjects } from "@/server/books/queries";
import { isUploadsFolderConfigured } from "@/server/drive/service";
import { PageTitle, Panel } from "../ui";

// Course-package import can run the full parse+persist+storage-upload
// pipeline synchronously (ADR-015 pattern, same ceiling as /parent/books).
export const maxDuration = 300;

/** One prepared course archive is the main path. Legacy entry points remain
 * available as a secondary fallback; a standalone textbook is a separate item. */
export default async function MaterialsImportPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const initialSection = tab === "video" || tab === "book" || tab === "materials" ? tab : "course";
  const { familyId } = await requireParentAccess();
  const [subjects, uploadEnabled] = await Promise.all([listSubjects(familyId), isUploadsFolderConfigured(familyId)]);
  const t = uk.parent.materials;

  return (
    <>
      <div className="mx-auto max-w-6xl">
      <PageTitle action={<Link href="/parent/videos" className="inline-flex min-h-11 items-center rounded-xl border border-p-line bg-p-surface px-4 text-sm font-semibold text-p-primary">Відкрити відеотеку →</Link>}>{t.title}</PageTitle>
      <p className="mb-6 max-w-2xl text-sm leading-relaxed text-p-muted">Обери, що хочеш додати. Готовий курс, окреме відео та книга мають свої форми — усе залишається пов’язаним із потрібним предметом або курсом.</p>
      <ContentWorkspace initialSection={initialSection}>
        {{
          course: <Panel title="Готовий курс — один ZIP"><UnifiedCourseImportPanel subjects={subjects} /></Panel>,
          video: <Panel title="Додати відео до уроку"><VideoLessonUploadPanel subjects={subjects} /><Link href="/parent/videos" className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-p-primary">Переглянути та впорядкувати завантажені відео →</Link></Panel>,
          book: <Panel title="Підручник або книга"><p className="max-w-2xl text-sm leading-relaxed text-p-muted">Додай PDF або EPUB до бібліотеки джерел. Завантаження книги й імпорт готового курсу — різні дії: сама книга не створює повний набір уроків.</p><div className="mt-4 flex flex-wrap gap-3"><Link href="/parent/books/add" className="inline-flex min-h-11 items-center rounded-xl bg-p-primary px-4 text-sm font-semibold text-white">Додати PDF / EPUB</Link><Link href="/parent/books" className="inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 text-sm font-semibold text-p-primary">Моя бібліотека</Link></div></Panel>,
          materials: <Panel title="Додаткові матеріали"><p className="mb-4 max-w-2xl text-sm leading-relaxed text-p-muted">Посібник або довідник у PDF / EPUB. Обери предмет і тип матеріалу. Файл з’явиться у «Моїх книгах»; його обробка використовує наявний механізм бібліотеки.</p><MaterialsImportPanel subjects={subjects} uploadEnabled={uploadEnabled} materialsOnly /></Panel>,
        }}
      </ContentWorkspace>
      <details className="mt-5 rounded-2xl border border-p-line bg-p-surface px-5 py-4">
        <summary className="cursor-pointer text-sm font-semibold text-p-muted">Старі способи завантаження</summary>
        <p className="my-3 text-xs leading-relaxed text-p-muted">Для раніше підготовлених матеріалів залишили попередні форми. Для нового курсу скористайтеся одним ZIP вище.</p>
        <Panel title="Книга, уроки й додаткові матеріали">
          <MaterialsImportPanel subjects={subjects} uploadEnabled={uploadEnabled} />
        </Panel>
        <Panel title="Математика (повний текстовий пакет)">
          <p className="-mt-2 mb-3.5 text-xs text-p-muted">
            Окремий формат (S35) — два файли JSON (public/course.json, private/teacher.json) замість одного zip, плюс необов&apos;язковий zip з рисунками.
          </p>
          <MathCourseV2ImportPanel subjects={subjects} />
        </Panel>
        <Panel title="Повний пакет уроків — відкриті завдання">
          <p className="-mt-2 mb-3.5 text-xs text-p-muted">
            Формат для будь-якого предмета з відкритими завданнями (S36) — чотири файли JSON (course.json, teacher.json, assets.json, task_tables.json), плюс необов&apos;язковий zip з ілюстраціями. Усі завдання тут відкриті (без варіантів відповіді).
            Якщо ваш пакет містить package.json і readings.json, використовуйте наступну форму «Спільний формат для всіх предметів — уроки та квізи».
          </p>
          <LiteratureV2ImportPanel subjects={subjects} />
        </Panel>
        <Panel title="Спільний формат для всіх предметів — уроки та квізи">
          <p className="-mt-2 mb-3.5 text-xs text-p-muted">
            Завантажте сім JSON окремо, як раніше: package.json, course.json, readings.json, teacher.json, assets.json, pages.json, task_tables.json. Нижче — два окремі необов’язкові ZIP: assets з ілюстраціями та lessons із PDF уроків. Якщо медіа не потрібні, залиште обидва ZIP порожніми; відповідні каталоги JSON можуть містити items: [].
          </p>
          <LiteratureV3ImportPanel subjects={subjects} />
        </Panel>
      </details>
      </div>
    </>
  );
}
