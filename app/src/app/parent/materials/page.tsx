import { MaterialsImportPanel } from "@/components/parent/materials/MaterialsImportPanel";
import { MathCourseV2ImportPanel } from "@/components/parent/materials/MathCourseV2ImportPanel";
import { LiteratureV2ImportPanel } from "@/components/parent/materials/LiteratureV2ImportPanel";
import { uk } from "@/i18n/uk";
import { requireParentAccess } from "@/server/auth/guards";
import { listSubjects } from "@/server/books/queries";
import { isUploadsFolderConfigured } from "@/server/drive/service";
import { PageTitle, Panel } from "../ui";

// Course-package import can run the full parse+persist+storage-upload
// pipeline synchronously (ADR-015 pattern, same ceiling as /parent/books).
export const maxDuration = 300;

/**
 * "Завантажити матеріали" (S34, PO instruction 2026-10-02, exact wording:
 * "в кабінеті зроби імпорт матеріалів по предмету: завантажити матеріали -
 * дроп-даун 'предмет' - дроп-даун 'категорія' (книга/уроки, додаткові
 * посібники, інше)") — ONE panel, two dropdowns before the file picker.
 * "Книга/уроки" runs the $0 course-package import (`courseImport.ts`);
 * "Додаткові посібники"/"Інше" reuse the existing Drive book-upload
 * mechanism, tagged with the chosen subject/category (see
 * `MaterialsImportPanel.tsx`'s own doc comment for exactly which category
 * gets which level of handling).
 */
export default async function MaterialsImportPage() {
  const { familyId } = await requireParentAccess();
  const [subjects, uploadEnabled] = await Promise.all([listSubjects(familyId), isUploadsFolderConfigured(familyId)]);
  const t = uk.parent.materials;

  return (
    <>
      <PageTitle>{t.title}</PageTitle>
      <Panel>
        <p className="-mt-2 mb-3.5 text-xs text-p-muted">{t.intro}</p>
        <MaterialsImportPanel subjects={subjects} uploadEnabled={uploadEnabled} />
      </Panel>
      <Panel title="Математика (повний текстовий пакет)">
        <p className="-mt-2 mb-3.5 text-xs text-p-muted">
          Окремий формат (S35) — два файли JSON (public/course.json, private/teacher.json) замість одного zip, плюс необов&apos;язковий zip з рисунками.
        </p>
        <MathCourseV2ImportPanel subjects={subjects} />
      </Panel>
      <Panel title="Зарубіжна література (повний пакет, відкриті завдання)">
        <p className="-mt-2 mb-3.5 text-xs text-p-muted">
          Окремий формат (S36) — чотири файли JSON (course.json, teacher.json, assets.json, task_tables.json), плюс необов&apos;язковий zip з ілюстраціями. Усі завдання тут відкриті (без варіантів відповіді).
        </p>
        <LiteratureV2ImportPanel subjects={subjects} />
      </Panel>
    </>
  );
}
