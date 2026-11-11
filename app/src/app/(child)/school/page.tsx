import Link from "next/link";
import { requireLessonAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { listSchoolEntries, readSchoolConnection } from "@/server/eschool/store";
import { SchoolEntries } from "@/components/eschool/SchoolEntries";
import { schoolDue } from "@/lib/eschool";
export const dynamic = "force-dynamic";
export default async function Page() {
  const { familyId } = await requireLessonAccess(); const { child } = await voiceActor(familyId);
  const [{ connection }, records] = await Promise.all([readSchoolConnection(familyId, child.id), listSchoolEntries(familyId, child.id)]);
  const due = records.entries.filter(({ entry }) => ["На сьогодні", "Термін минув"].includes(schoolDue(entry.source, entry.status) ?? ""));
  return <main className="mx-auto max-w-5xl space-y-6 px-4 pb-32 pt-20 md:px-6"><Link href="/today" className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 font-bold">← На головну</Link><header><h1 className="text-3xl font-extrabold">Мій шкільний щоденник</h1><p className="mt-2 text-muted">Умови завдань, теми уроків і твій поступ.</p>{connection?.lastSync && <p className="mt-2 text-xs text-muted">Дані оновлено: {new Date(connection.lastSync).toLocaleString("uk-UA", { timeZone: "Europe/Kiev" })}. Якщо вчитель змінив завдання після цього, попроси тата синхронізувати щоденник.</p>}</header>{due.length > 0 && <section role="status" className="rounded-2xl border border-secondary bg-surface p-4"><p className="font-extrabold">Є завдання на сьогодні або з минулим терміном: {due.length}</p><p className="mt-1 text-sm text-muted">Переглянь список і вибери, з чого почати. Якщо термін змінився, перевір оригінальний щоденник.</p></section>}<SchoolEntries entries={records.entries} limited={records.limited} /></main>;
}
