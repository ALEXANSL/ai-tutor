import {beforeEach,expect,it,vi}from"vitest";
import type{StudioSourceCorpus}from"@/lib/studio";
const f=vi.hoisted(()=>({system:"neutral-v1",rows:[] as {id:string;family_id:string;type:string;payload:Record<string,unknown>}[],notes:vi.fn()}));
vi.mock("./prompts",()=>({studioSystem:()=>f.system}));vi.mock("./source-corpus",()=>({readStudioSourceNotes:f.notes}));
vi.mock("@/server/db/family-scope",()=>({forFamily:(family:string)=>{const filters:[string,unknown][]=[];const chain={eq:(key:string,value:unknown)=>{filters.push([key,value]);return chain;},maybeSingle:async()=>({data:f.rows.find(row=>row.family_id===family&&filters.every(([k,v])=>row[k as keyof typeof row]===v))??null,error:null})};return{select:()=>chain,client:{from:()=>({upsert:async(row:typeof f.rows[number])=>{if(!f.rows.some(existing=>existing.id===row.id))f.rows.push(structuredClone(row));return{error:null}}})}}}}));
import{readStudioSourceCatalog,saveStudioSourceCatalog}from"./source-catalog";
const corpus:StudioSourceCorpus={id:"11111111-1111-4111-8111-111111111111",partCount:2,chunkCount:306,characterCount:474000,blankChunks:0,pageFrom:1,pageTo:306,analyzed:2,notes:["leaf0","leaf1"],catalog:["overview"],reduceCursor:0,reduced:[]};
beforeEach(()=>{f.rows=[];f.system="neutral-v1";f.notes.mockImplementation(async(_f:string,_c:string,refs:string[])=>refs.map(ref=>({fromPart:ref==="leaf1"?1:0,toPart:ref==="leaf0"?0:1,source:{id:ref,title:ref,text:"Конспект",kind:"summary",page:null}})));});
it("reuses only a completed intact same-family same-source same-contract catalog",async()=>{
 expect(await readStudioSourceCatalog("family",corpus)).toBeNull();await saveStudioSourceCatalog("family",corpus);expect(await readStudioSourceCatalog("family",corpus)).toEqual({notes:corpus.notes,catalog:corpus.catalog});expect(await readStudioSourceCatalog("other",corpus)).toBeNull();f.system="updated-contract";expect(await readStudioSourceCatalog("family",corpus)).toBeNull();
});
it("rejects incomplete analysis and damaged technical coverage rather than guessing or silently regenerating",async()=>{
 await expect(saveStudioSourceCatalog("family",{...corpus,analyzed:1})).rejects.toThrow("незавершений");await saveStudioSourceCatalog("family",corpus);f.notes.mockResolvedValue([{fromPart:1,toPart:1,source:{}}]);await expect(readStudioSourceCatalog("family",corpus)).rejects.toThrow();
});
it("does not label mixed-version resumed analysis as a new-contract shared cache",async()=>{
 await saveStudioSourceCatalog("family",{...corpus,analysisContract:"old-contract"});expect(f.rows).toHaveLength(0);
});
