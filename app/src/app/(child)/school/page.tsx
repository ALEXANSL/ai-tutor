import { schoolSubjects } from "@/server/eschool/service";
import Link from "next/link";
import { requireLessonAccess } from "@/server/auth/guards";
import { voiceActor } from "@/server/voice/service";
import { listSchoolEntries, readSchoolConnection } from "@/server/eschool/store";
import { SchoolEntries } from "@/components/eschool/SchoolEntries";
import { schoolToday } from "@/lib/eschool";
import { schoolDateShift } from "@/lib/school-schedule";
export const dynamic = "force-dynamic";
export default async function Page() {
  const { familyId } = await requireLessonAccess(); const { child } = await voiceActor(familyId);
  const [{ connection }, records, subjects] = await Promise.all([readSchoolConnection(familyId, child.id), listSchoolEntries(familyId, child.id), schoolSubjects(familyId, true)]);
  // Status-free on purpose: teachers rarely mark homework done in the diary, so "overdue" would be stale.
  const today = schoolToday(); const tomorrow = schoolDateShift(today, 1);
  const dueOn = (date: string) => records.entries.filter(({ entry }) => entry.source.kind === "homework" && !entry.source.cancelled && entry.source.dueDate === date).length;
  const dueToday = dueOn(today); const dueTomorrow = dueOn(tomorrow);
  return <main className="mx-auto max-w-[1600px] space-y-6 px-4 pb-32 pt-20 md:px-6"><Link href="/today" className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 font-bold">← На головну</Link><header><h1 className="text-3xl font-extrabold">Мій шкільний щоденник</h1><p className="mt-2 text-muted">Розклад уроків і домашні завдання по днях.</p>{connection?.lastSync && <p className="mt-2 text-xs text-muted">Дані оновлено: {new Date(connection.lastSync).toLocaleString("uk-UA", { timeZone: "Europe/Kiev" })}. Якщо вчитель змінив завдання після цього, попроси тата синхронізувати щоденник.</p>}</header>{(dueToday > 0 || dueTomorrow > 0) && <section role="status" className="rounded-2xl border border-secondary bg-surface p-4"><p className="font-extrabold">{[dueToday > 0 && `На сьогодні ДЗ: ${dueToday}`, dueTomorrow > 0 && `На завтра ДЗ: ${dueTomorrow}`].filter(Boolean).join(" · ")}</p><p className="mt-1 text-sm text-muted">Відкрий «Домашні завдання», щоб побачити їх по днях.</p></section>}<SchoolEntries subjects={subjects} entries={records.entries} limited={records.limited} /></main>;
}
