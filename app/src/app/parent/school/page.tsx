import { requireParentAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { listSchoolEntries, readSchoolConnection } from "@/server/eschool/store";
import { schoolSubjects } from "@/server/eschool/service";
import { SchoolImport } from "@/components/eschool/SchoolImport";
import { SchoolEntries } from "@/components/eschool/SchoolEntries";
import { PageTitle } from "../ui";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export default async function Page() {
  const { familyId } = await requireParentAccess(); const { child } = await voiceActor(familyId);
  const [{ connection }, records, subjects] = await Promise.all([readSchoolConnection(familyId, child.id), listSchoolEntries(familyId, child.id), schoolSubjects(familyId)]);
  return <main className="mx-auto max-w-[1600px]"><PageTitle>Єдина школа</PageTitle><p className="mb-5 max-w-3xl text-sm text-p-muted">Теми та домашні завдання з власного щоденника. Перевір перший імпорт, прив’яжи завдання до підготовлених уроків і відстежуй виконання.</p><SchoolImport connection={connection} /><SchoolEntries entries={records.entries} limited={records.limited} subjects={subjects} parent /></main>;
}
