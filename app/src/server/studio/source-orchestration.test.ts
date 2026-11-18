import { beforeEach,expect,it,vi } from "vitest";
import type { StudioProject,StudioSource } from "@/lib/studio";
import { studioProjectFixture,studioPlanFixture } from "./__fixtures__/project";
const f=vi.hoisted(()=>({parts:[] as StudioSource[][],notes:new Map<string,{source:StudioSource;fromPart:number;toPart:number;quotes?:{sourceId:string;text:string}[]}>(),cache:vi.fn()}));
vi.mock("./source-catalog",()=>({saveStudioSourceCatalog:f.cache}));
vi.mock("./source-corpus",()=>({readStudioSourcePart:async(_f:string,_c:unknown,index:number)=>f.parts[index],readStudioSourceNotes:async(_f:string,_c:string,refs:string[])=>refs.map(ref=>{const note=f.notes.get(ref);if(!note)throw Error("missing");return note;}),writeStudioSourceNote:async(_f:string,_c:string,note:typeof f.notes extends Map<string,infer T>?T:never)=>{const ref=`n${f.notes.size}`;f.notes.set(ref,note);return ref;}}));
import { applyStudioSourceTask,prepareStudioLessonSources,studioSourceTask,studioLessonModelSources,validateStudioSourcePlan } from "./source-orchestration";
const source=(id:string,text="Навчальний матеріал"):StudioSource=>({id,title:id,text,page:1,kind:"book"});
const noteResult={title:"Огляд",summary:"Змістовне пояснення всіх тем цієї частини джерела.",topics:["Тема"],limitations:[],quotes:[]};
let project:StudioProject;
beforeEach(()=>{vi.clearAllMocks();f.notes.clear();f.parts=[[source("p1")],[source("p2")]];project=studioProjectFixture({sources:[],phase:"analyze",sourceCorpus:{id:"corpus",partCount:2,chunkCount:43,characterCount:50000,blankChunks:0,pageFrom:42,pageTo:84,analyzed:0,notes:[],catalog:[],reduceCursor:0,reduced:[]}});});
it("checkpoints every source part then caches the completed neutral overview",async()=>{
 for(let i=0;i<2;i++){const task=await studioSourceTask("family",project);expect(task.sources[0]!.id).toBe(`p${i+1}`);project={...project,...await applyStudioSourceTask("family",project,task,noteResult)};}
 expect(project.phase).toBe("plan");expect(project.sourceCorpus?.analyzed).toBe(2);expect(project.sourceCorpus?.catalog).toHaveLength(2);expect(f.cache).toHaveBeenCalledTimes(1);
});
it("returns prepared material to sufficiency assessment before reading a book",async()=>{
 project.sourceSelection={candidates:[],fallbackMaterialId:null,selectedIds:[],assessed:false};project.sourceCorpus!.partCount=1;
 project={...project,...await applyStudioSourceTask("family",project,await studioSourceTask("family",project),noteResult)};expect(project.phase).toBe("assess");
});
it("uses all raw material of a 43-page lesson when it fits, without a page-count cap",async()=>{
 f.parts=[Array.from({length:43},(_,i)=>({...source(`page-${i+42}`),page:i+42}))];project.sourceCorpus!.partCount=1;
 f.notes.set("catalog",{fromPart:0,toPart:0,source:{...source("book-parts-1-1"),kind:"summary"}});project.sourceCorpus!.catalog=["catalog"];project.phase="author";project.plan={...studioPlanFixture,lessons:[{title:"Цілісний твір",goal:"Пояснити твір",sourceIds:["book-parts-1-1"]}]};
 project={...project,...await prepareStudioLessonSources("family",project)};const sources=await studioLessonModelSources("family",project);expect(sources).toHaveLength(43);expect(sources.at(-1)!.page).toBe(84);expect(project.lessonSources?.context?.rawParts).toEqual([0]);
});
it("builds focused notes for every assigned large source part rather than truncating context",async()=>{
 f.parts=[0,1,2].map(i=>[source(`p${i}`,"Приклад. ".repeat(8000))]);project.sourceCorpus!.partCount=3;f.notes.set("catalog",{fromPart:0,toPart:2,source:{...source("group"),kind:"summary"}});project.sourceCorpus!.catalog=["catalog"];project.phase="author";project.plan={...studioPlanFixture,lessons:[{title:"Повна тема",goal:"Глибокий розбір",sourceIds:["group"]}]};
 project={...project,...await prepareStudioLessonSources("family",project)};expect(project.phase).toBe("lesson_sources");
 for(let i=0;i<3;i++){const task=await studioSourceTask("family",project);expect(task.fromPart).toBe(i);project={...project,...await applyStudioSourceTask("family",project,task,noteResult)};}
 expect(project.phase).toBe("author");expect((await studioLessonModelSources("family",project))).toHaveLength(3);
});
it("drops only unverified optional quotes and propagates their warning through reduction",async()=>{
 const task=await studioSourceTask("family",project);const changes=await applyStudioSourceTask("family",project,task,{...noteResult,quotes:[{sourceId:"p1",text:"Вигадана цитата"},{sourceId:"p1",text:"Навчальний матеріал"}]});
 const first=f.notes.get(changes.sourceCorpus!.notes[0]!)!;expect(first.quotes).toEqual([{sourceId:"p1",text:"Навчальний матеріал"}]);expect(first.source.text).toContain("Відхилено непідтверджені цитати: 1");expect(first.source.evidenceWarnings).toHaveLength(1);
 const summary={...source("summary","Переказ не є цитатою. ".repeat(300)),kind:"summary" as const,evidenceWarnings:first.source.evidenceWarnings};
 const reduced=await applyStudioSourceTask("family",project,{scope:"book",reducing:true,sources:[summary],fromPart:0,toPart:1,count:2,verifiedQuotes:[]},{...noteResult,quotes:[{sourceId:"summary",text:"Переказ не є цитатою"}]});
 const saved=f.notes.get(reduced.sourceCorpus!.reduced[0]??reduced.sourceCorpus!.catalog[0]!)!;expect(saved.quotes).toEqual([]);expect(saved.source.evidenceWarnings).toHaveLength(1);expect(saved.source.text).toContain("Не цитуй такі фрази з summary");
});

it("requires complete source-group mapping or explicit justified exclusions",async()=>{
 f.notes.set("a",{fromPart:0,toPart:0,source:source("part-a")});f.notes.set("b",{fromPart:1,toPart:1,source:source("part-b")});project.sourceCorpus!.catalog=["a","b"];
 const plan={...studioPlanFixture,lessons:[{...studioPlanFixture.lessons[0]!,sourceIds:["part-a"]}]};await expect(validateStudioSourcePlan("f",project,plan)).rejects.toThrow("COVERAGE");await expect(validateStudioSourcePlan("f",project,{...plan,sourceExclusions:[{sourceId:"part-b",reason:"Службова бібліографія"}]})).resolves.toBeUndefined();
 await expect(validateStudioSourcePlan("f",project,{...plan,lessons:[{...plan.lessons[0]!,sourceIds:["foreign"]}]})).rejects.toThrow("SOURCE-PLAN");
});
it("groups reduction by bytes and stops non-shrinking summaries instead of spending in a loop",async()=>{
 project.phase="outline";project.sourceCorpus!.catalog=["a","b","c","d"];
 for(const [index,id]of["a","b","c","d"].entries())f.notes.set(id,{fromPart:index,toPart:index,source:source(id,"Довгий конспект. ".repeat(1200))});
 const task=await studioSourceTask("family",project);expect(task.count).toBeLessThan(4);expect(Buffer.byteLength(JSON.stringify(task.sources))).toBeLessThan(106000);
 await expect(applyStudioSourceTask("f",project,{...task,sources:[source("small")],verifiedQuotes:[]},{...noteResult,summary:"Більший результат ".repeat(100)})).rejects.toThrow("NO-PROGRESS");
});
it("preserves a paid completed overview if optional shared-cache persistence fails",async()=>{
 project.sourceCorpus!.partCount=1;f.cache.mockRejectedValueOnce(new Error("cache unavailable"));const changes=await applyStudioSourceTask("family",project,await studioSourceTask("family",project),noteResult);
 expect(changes.phase).toBe("plan");expect(changes.sourceCorpus?.analyzed).toBe(1);expect(changes.sourceCorpus?.notes).toHaveLength(1);expect(changes.sourceNotes?.join(" ")).toContain("повторний платний аналіз тут не запускається");
});

it("resumes a split lesson part without losing text or repeating completed notes",async()=>{
 const original="Література 📖 ".repeat(1200);
 f.parts=[[source("p1",original)]];
 project.phase="lesson_sources";
 project.lessonSources={lessonIndex:0,targetPhase:"author",partIndexes:[0],cursor:0,notes:[],catalog:[],reduceCursor:0,reduced:[],recoverySlice:0};
 const fragments:string[]=[];
 while(project.phase==="lesson_sources" && fragments.length<10){
   const task=await studioSourceTask("family",project);
   fragments.push(task.sources[0]!.text);
   expect(Array.from(task.sources[0]!.text).length).toBeLessThanOrEqual(5000);
   project={...project,...await applyStudioSourceTask("family",project,task,noteResult)};
 }
 expect(fragments.join("")).toBe(original);
 expect(new Set(project.lessonSources!.context!.ids).size).toBe(fragments.length);
 expect(project.phase).toBe("author");
});

it("reuses completed lesson notes and fills remaining parts from planning with original text",async()=>{
 const {reusePreparedLessonSources}=await import("./source-orchestration");
 project.sourceCorpus!.analyzed=2;
 project.sourceCorpus!.notes=["first","second"];
 for(const [index,ref] of ["first","second","focused"].entries()){
   const part=index===2?0:index;
   f.notes.set(ref,{fromPart:part,toPart:part,source:{...source(ref),kind:"summary"}});
 }
 project.phase="lesson_sources";
 project.lessonSources={lessonIndex:0,targetPhase:"author",partIndexes:[0,1],cursor:1,notes:["focused"],catalog:[],reduceCursor:0,reduced:[]};
 project={...project,...await reusePreparedLessonSources("family",project)};
 expect(project.phase).toBe("author");
 expect(project.lessonSources!.context!.noteRefs).toEqual(["focused","second"]);
 expect((await studioLessonModelSources("family",project)).map(item=>item.id)).toEqual(["focused","second","p1","p2"]);
});
