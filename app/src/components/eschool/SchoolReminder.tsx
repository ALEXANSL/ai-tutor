import Link from "next/link";
import { listSchoolEntries } from "@/server/eschool/store";
import { schoolDue } from "@/lib/eschool";
export async function SchoolReminder({ familyId, childId }: { familyId: string; childId: string }) {
  const records = await listSchoolEntries(familyId, childId).catch(() => ({ entries: [], limited: false }));
  const pending = records.entries.filter(({ entry }) => entry.source.kind === "homework" && (entry.status !== "done" || entry.changed));
  if (!pending.length) return null;
  const urgent = pending.filter(({ entry }) => ["На сьогодні", "Термін минув"].includes(schoolDue(entry.source, entry.status) ?? ""));
  return <Link href="/school" className="mx-6 mb-4 block rounded-2xl border border-secondary bg-surface p-4"><p className="font-extrabold">📅 {urgent.length ? `Переглянь домашні завдання на сьогодні: ${urgent.length}` : `У щоденнику є домашні завдання: ${pending.length}`}</p><p className="mt-1 text-sm text-muted">Відкрий умови, обери урок або познач виконане. Показано дані останньої синхронізації →</p></Link>;
}
