import "server-only";
import { schoolSubjectCandidates } from "@/lib/eschool-subject-match";
import { randomUUID } from "node:crypto";
import { schoolPacketSchema, type SchoolConnection, type SchoolEntry, type SchoolPacket, type SchoolStatus } from "@/lib/eschool";
import { forFamily } from "@/server/db/family-scope";
import { createSchoolDoc, readSchoolConnection, readSchoolDoc, saveSchoolDoc, SCHOOL_CONNECTION, SCHOOL_ENTRY, schoolId } from "./store";
import { getSubjectDetail } from "@/server/subjects/queries";
import { importedLessonHref } from "@/lib/imported-lesson-link";
function sameIdentity(a: SchoolPacket["identity"], b: SchoolPacket["identity"]) { return a.schoolId === b.schoolId && a.pupilId === b.pupilId; }
export async function schoolSubjects(familyId: string, activeOnly = false) {
  let query = forFamily(familyId).select("subjects", "id,name:name_uk").eq("kind", "school_subject");
  if (activeOnly) query = query.eq("active", true);
  const { data, error } = await query.order("sort_order").returns<{ id: string; name: string }[]>();
  if (error) throw new Error("Не вдалося завантажити предмети."); return data ?? [];
}
export async function importSchoolPacket(familyId: string, childId: string, raw: unknown) {
  const packet = schoolPacketSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(packet)) > 1800000) throw new Error("Пакет завеликий. Синхронізуй коротший діапазон дат.");
  const age = Date.now() - Date.parse(packet.capturedAt);
  if (age > 24 * 60 * 60 * 1000 || age < -5 * 60 * 1000) throw new Error("Пакет застарів або час пристрою неправильний. Прочитай щоденник ще раз.");
  const initialConnection = await readSchoolConnection(familyId, childId);
  const connectionId = initialConnection.id; let connection = initialConnection.connection;
  if (!connection) {
    const initial: SchoolConnection = { version: 1, revision: 0, childId, identity: null, lastSync: null, lastCapturedAt: null, lastPacketId: null, range: null, count: 0, warnings: [], lock: null };
    await createSchoolDoc(familyId, connectionId, SCHOOL_CONNECTION, initial);
    connection = (await readSchoolConnection(familyId, childId)).connection;
    if (!connection) throw new Error("Не вдалося підготувати підключення.");
  }
  if (connection.identity && !sameIdentity(connection.identity, packet.identity)) throw new Error("Зараз підключено інший профіль учня. Відключи його перед імпортом іншого профілю.");
  if (connection.lastPacketId === packet.packetId) return { count: connection.count, repeated: true };
  if (connection.lastCapturedAt && Date.parse(packet.capturedAt) < Date.parse(connection.lastCapturedAt)) throw new Error("Цей пакет старіший за останню синхронізацію. Прочитай свіжі дані.");
  if (connection.lock && Date.now() - Date.parse(connection.lock.at) < 120000) throw new Error("Синхронізація вже виконується. Онови стан за хвилину.");
  const token = randomUUID();
  connection = await saveSchoolDoc(familyId, connectionId, SCHOOL_CONNECTION, connection, { identity: packet.identity, lock: { token, at: new Date().toISOString() } });
  try {
    const subjects = await schoolSubjects(familyId);
    const now = new Date().toISOString();
    async function save(source: SchoolPacket["entries"][number]) {
      const id = schoolId(SCHOOL_ENTRY, familyId, childId, String(packet.identity.schoolId), String(packet.identity.pupilId), source.externalId);
      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await readSchoolDoc<SchoolEntry>(familyId, childId, id, SCHOOL_ENTRY);
        const matching = schoolSubjectCandidates(source.subject, subjects);
        const subjectId = matching.length === 1 ? matching[0]!.id : null;
        if (existing) {
          if (Date.parse(existing.capturedAt) > Date.parse(packet.capturedAt)) return;
          const meaningful = (value: SchoolPacket["entries"][number]) => JSON.stringify([value.kind, value.subject, value.lessonDate, value.dueDate, value.topic, value.text, value.attachments, value.cancelled]);
          const changed = meaningful(existing.source) !== meaningful(source);
          try { await saveSchoolDoc(familyId, id, SCHOOL_ENTRY, existing, { source, capturedAt: packet.capturedAt, syncedAt: now, changed: existing.changed || changed }); return; }
          catch (error) { if (attempt === 2) throw error; }
        } else {
          const entry: SchoolEntry = { version: 1, revision: 0, childId, identity: packet.identity, source, capturedAt: packet.capturedAt, syncedAt: now, status: "todo", changed: false, subjectId, topicId: null, lessonHref: null, workHref: null };
          if (await createSchoolDoc(familyId, id, SCHOOL_ENTRY, entry)) return;
        }
      }
      throw new Error("Запис змінюється одночасно. Повтори синхронізацію.");
    }
    for (let index = 0; index < packet.entries.length; index += 8) await Promise.all(packet.entries.slice(index, index + 8).map(save));
    await saveSchoolDoc(familyId, connectionId, SCHOOL_CONNECTION, connection, { lock: null, lastSync: now, lastCapturedAt: packet.capturedAt, lastPacketId: packet.packetId, range: packet.range, count: packet.entries.length, warnings: packet.warnings });
    return { count: packet.entries.length, repeated: false };
  } catch (error) {
    const latest = (await readSchoolConnection(familyId, childId)).connection;
    if (latest?.lock?.token === token) await saveSchoolDoc(familyId, connectionId, SCHOOL_CONNECTION, latest, { lock: null, warnings: ["Імпорт не завершено. Уже збережені записи залишились; можна повторити той самий пакет."] });
    throw error;
  }
}
export async function updateSchoolEntry(familyId: string, childId: string, id: string, revision: number, changes: { status?: SchoolStatus; subjectId?: string | null; topicId?: string | null; workHref?: string }) {
  const entry = await readSchoolDoc<SchoolEntry>(familyId, childId, id, SCHOOL_ENTRY);
  if (!entry || entry.revision !== revision) throw new Error("Запис уже змінився. Онови щоденник.");
  const update: Partial<SchoolEntry> = {};
  if (changes.status) { update.status = changes.status; update.changed = false; }
  if (changes.workHref) update.workHref = changes.workHref;
  if (changes.subjectId !== undefined) {
    if (!changes.subjectId) Object.assign(update, { subjectId: null, topicId: null, lessonHref: null });
    else {
      const detail = await getSubjectDetail(familyId, changes.subjectId);
      if (!detail) throw new Error("Предмет недоступний.");
      const topic = changes.topicId ? detail.topics.find(topic => topic.id === changes.topicId) : null;
      if (changes.topicId && !topic) throw new Error("Урок не належить цьому предмету.");
      Object.assign(update, { subjectId: changes.subjectId, topicId: topic?.id ?? null, lessonHref: topic ? importedLessonHref(topic) : null });
    }
  }
  return saveSchoolDoc(familyId, id, SCHOOL_ENTRY, entry, update);
}
export async function disconnectSchool(familyId: string, childId: string) {
  const { id, connection } = await readSchoolConnection(familyId, childId);
  if (!connection) return;
  if (connection.lock && Date.now() - Date.parse(connection.lock.at) < 120000) throw new Error("Дочекайся завершення синхронізації.");
  await saveSchoolDoc(familyId, id, SCHOOL_CONNECTION, connection, { identity: null, lastPacketId: null, lastCapturedAt: null, lock: null });
}
