import Link from "next/link";
import { UnifiedCourseImportPanel } from "@/components/parent/materials/UnifiedCourseImportPanel";
import { MaterialsImportPanel } from "@/components/parent/materials/MaterialsImportPanel";
import { MathCourseV2ImportPanel } from "@/components/parent/materials/MathCourseV2ImportPanel";
import { LiteratureV2ImportPanel } from "@/components/parent/materials/LiteratureV2ImportPanel";
import { LiteratureV3ImportPanel } from "@/components/parent/materials/LiteratureV3ImportPanel";
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
export default async function MaterialsImportPage() {
  const { familyId } = await requireParentAccess();
  const [subjects, uploadEnabled] = await Promise.all([listSubjects(familyId), isUploadsFolderConfigured(familyId)]);
  const t = uk.parent.materials;

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <Panel title="Готовий курс — один ZIP">
        <UnifiedCourseImportPanel subjects={subjects} />
      </Panel>
      <Panel title="Потрібно додати лише підручник?">
        <p className="text-sm leading-relaxed text-p-muted">Книга у PDF або EPUB додається окремо. Готові уроки з архіву завантажуйте у формі вище.</p>
        <Link href="/parent/books/add" className="mt-3 inline-flex min-h-11 items-center rounded-xl border border-p-line px-4 text-sm font-semibold text-p-primary">Додати книгу PDF / EPUB</Link>
      </Panel>
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
    </>
  );
}
