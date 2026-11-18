import "server-only";
import { createHash } from "node:crypto";
import { forFamily } from "@/server/db/family-scope";
import type { StudioSourceCorpus } from "@/lib/studio";
import { readStudioSourceNotes, type CorpusSnapshot } from "./source-corpus";
import { studioSystem } from "./prompts";
const TYPE = "studio.source_catalog";
export const studioSourceAnalysisContract = () => createHash("sha256").update(`generic-source-overview-v1:${studioSystem("studio.source")}`).digest("hex");
function key(familyId: string, corpusId: string, version: string) { const hex = createHash("sha256").update(JSON.stringify([familyId,corpusId,version])).digest("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; }
interface Catalog { corpusId: string; version: string; partCount: number; notes: string[]; catalog: string[]; }
export async function readStudioSourceCatalog(familyId: string, corpus: CorpusSnapshot): Promise<Pick<StudioSourceCorpus,"notes"|"catalog"> | null> {
  const version = studioSourceAnalysisContract();
  const found = await forFamily(familyId).select("jobs","payload").eq("id",key(familyId,corpus.id,version)).eq("type",TYPE).maybeSingle<{payload:Catalog}>();
  if (found.error) throw new Error("Не вдалося перевірити збережений огляд матеріалу.");
  if (!found.data) return null;
  const value=found.data.payload;
  if(value.corpusId!==corpus.id||value.version!==version||value.partCount!==corpus.partCount||!Array.isArray(value.notes)||value.notes.length!==corpus.partCount||!Array.isArray(value.catalog)||!value.catalog.length)throw new Error("Збережений огляд матеріалу пошкоджено.");
  const notes=await readStudioSourceNotes(familyId,corpus.id,value.notes);
  if(notes.some((note,index)=>note.fromPart!==index||note.toPart!==index))throw new Error("Не всі частини джерела представлені у збереженому огляді.");
  const catalog=await readStudioSourceNotes(familyId,corpus.id,value.catalog);
  let next=0;for(const note of catalog){if(note.fromPart!==next)throw new Error("Огляд пропускає частини джерела.");next=note.toPart+1;}if(next!==corpus.partCount)throw new Error("Огляд джерела неповний.");
  return {notes:value.notes,catalog:value.catalog};
}
export async function saveStudioSourceCatalog(familyId:string,corpus:StudioSourceCorpus){
  if(corpus.analyzed!==corpus.partCount)throw new Error("Не можна зберегти незавершений огляд.");
  const version=studioSourceAnalysisContract();
  if(corpus.analysisContract && corpus.analysisContract !== version) return;
  const scope=forFamily(familyId);
  const saved=await scope.client.from("jobs").upsert({id:key(familyId,corpus.id,version),family_id:familyId,type:TYPE,status:"done",payload:{corpusId:corpus.id,version,partCount:corpus.partCount,notes:corpus.notes,catalog:corpus.catalog}},{onConflict:"id",ignoreDuplicates:true});
  if(saved.error)throw new Error("Не вдалося зберегти огляд матеріалу.");
  if(!await readStudioSourceCatalog(familyId,corpus))throw new Error("Не вдалося підтвердити збережений огляд.");
}
