import "server-only";
import { createHash } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import type { StudioUnit } from "@/lib/studio";
const TYPE = "studio.unit";
function unitId(familyId: string, projectId: string, index: number, unit: StudioUnit) {
  const hex = createHash("sha256").update(JSON.stringify([familyId, projectId, index, unit])).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
export async function readStoredUnits(familyId: string, projectId: string, refs: string[]): Promise<StudioUnit[]> {
  const found = new Map<string, { index: number; unit: StudioUnit }>();
  for (let offset = 0; offset < refs.length; offset += 80) {
    const { data, error } = await forFamily(familyId).select("jobs", "id,payload").eq("type", TYPE).eq("payload->>projectId", projectId).in("id", refs.slice(offset, offset + 80)).returns<{ id: string; payload: { index: number; unit: StudioUnit } }[]>();
    if (error) throw new Error("Не вдалося прочитати матеріали курсу.");
    for (const row of data ?? []) found.set(row.id, row.payload);
  }
  return refs.map((id, index) => { const entry = found.get(id); if (!entry || entry.index !== index || !entry.unit?.content) throw new Error("Не всі матеріали курсу доступні. Онови сторінку; чернетку не змінено."); return entry.unit; });
}
/** Immutable versions are written before the project CAS; a losing writer cannot overwrite the winner's lesson. */
export async function writeStoredUnits(familyId: string, projectId: string, units: StudioUnit[], previousRefs: string[] = []) {
  const refs = units.map((unit, index) => unitId(familyId, projectId, index, unit));
  const changed = units.flatMap((unit, index) => {
    if (refs[index] === previousRefs[index]) return [];
    if (Buffer.byteLength(JSON.stringify(unit)) > 500000) throw new Error("Матеріал одного уроку завеликий. Скороти цей урок; інші частини збережено.");
    return [{ id: refs[index]!, type: TYPE, status: "done", payload: { projectId, index, unit } }];
  });
  for (let offset = 0; offset < changed.length; offset += 5) {
    const { error } = await forFamily(familyId).upsert("jobs", changed.slice(offset, offset + 5), "id");
    if (error) throw new Error("Не вдалося зберегти матеріали уроку. Готові частини курсу залишаються збереженими.");
  }
  return refs;
}
